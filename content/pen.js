/*
 * 토스 차트 펜 — content/pen.js
 *
 * 한 파일이 두 역할로 분기한다.
 *   - 최상위 프레임(window.top === window.self) → "툴바" 역할
 *       Shadow DOM 플로팅 툴바, 종목별 localStorage 저장/복원, iframe에 명령 전달
 *   - 서브프레임 + window.tradingViewApi 존재 → "엔진" 역할
 *       펜 캡처 + 직접 캔버스 렌더 (TradingView 도형 API 미사용)
 *
 * MV3 world: "MAIN" 이라 chrome.* API 를 못 쓴다 → 저장은 top 프레임 localStorage 사용.
 * 프레임 통신은 postMessage. 엔진이 보낸 'ready' 의 event.source 를 저장해
 * iframe id 매칭 없이 양방향 통신한다. (same-origin about:blank → targetOrigin '*')
 *
 * 렌더링: 그린 선을 TradingView 도형(brush)으로 주입하지 않고 자체 캔버스에 직접 그린다.
 * 각 점을 데이터좌표 {i: 연속 logical index, p: 가격} 로 저장하고, 매 프레임 현재 차트
 * 투영(logical→x, 가격→y)으로 재투영해 다시 그린다 → 줌/스크롤에 붙어 움직이며(앵커링),
 * 봉 단위 스냅 없이 그린 그대로 표현되고, 마지막 봉 너머(미래)에도 제약 없이 그릴 수 있다.
 * (TradingView brush 는 x 를 정수 봉 index 로 스냅하고 미래 영역을 클램프해 부적합)
 */
(function () {
  'use strict';

  var NS = 'tossPen';
  var isTop = (window.top === window.self);

  // 역할 분기는 IIFE 맨 끝에서 실행한다.
  // (CSS/아이콘 SVG 등 하단에서 var 로 할당되는 값들이 모두 준비된 뒤 buildToolbar 가 돌도록)

  // =========================================================================
  // 공통: 메시지 전송 헬퍼
  // =========================================================================
  function postTo(win, dir, payload) {
    if (!win) return;
    var msg = Object.assign({ source: NS, dir: dir }, payload);
    try { win.postMessage(msg, '*'); } catch (e) {}
  }

  // =========================================================================
  // 엔진 역할 (TradingView iframe 내부)
  // =========================================================================
  function initEngineWhenReady() {
    var tries = 0;
    var max = 60; // 약 30초 동안 폴링 (TV 위젯 로딩 대기)
    var timer = setInterval(function () {
      tries++;
      if (hasApi()) {
        clearInterval(timer);
        startEngine();
      } else if (tries >= max) {
        clearInterval(timer); // 차트 프레임이 아니면 조용히 포기 (광고 iframe 등)
      }
    }, 500);
  }

  function hasApi() {
    try {
      return !!(window.tradingViewApi &&
                typeof window.tradingViewApi.activeChart === 'function' &&
                window.tradingViewApi.activeChart());
    } catch (e) { return false; }
  }

  function startEngine() {
    var mode = 'off';       // 'off' | 'pen' | 'eraser'
    var style = { color: '#FF3B30', width: 3 };
    var currentToken = 0;   // top 이 부여한 symbolToken (stale 저장 방지)
    var strokes = [];       // [{ color, width, pts:[{i,p}] }]  i=연속 logical index, p=가격
    var cur = null;         // 그리는 중인 stroke
    var erasing = false;    // 드래그/우클릭 지우기 진행 중
    var eraseChanged = false; // 이번 지우기 드래그에서 변경 발생 여부
    var eraserPos = null;   // 지우개 커서 표시 위치 {x,y}
    var ERASER_R = 12;      // 지우개 반경(px)
    var overlay = null;     // 항상 떠 있는 렌더 캔버스
    var ctx2d = null;
    var dpr = 1;
    var lastSig = '';       // 직전 투영 시그니처 (뷰 변경 감지)
    var dirty = true;       // 다시 그려야 함
    var rafOn = false;

    function chart() { try { return window.tradingViewApi.activeChart(); } catch (e) { return null; } }

    // 현재 차트 투영. x = 연속 logical index, y 변환은 render 에서 buildPriceToY 로 만든다.
    // 줌/스크롤/리사이즈마다 값이 바뀌므로 저장된 데이터좌표를 매 프레임 픽셀로 재투영(앵커링).
    function proj() {
      var c = chart(); if (!c) return null;
      try {
        var ts = c.getTimeScale();
        var pane = c.getPanes()[0];
        var ps = pane.getMainSourcePriceScale();
        var W = ts.width(), H = pane.getHeight();
        var lr = c.getTimeScaleLogicalRange();
        if (!lr || !(lr._right > lr._left) || !W || !H) return null;
        var span = lr._right - lr._left;
        var p0 = ps.coordinateToPrice(0), pH = ps.coordinateToPrice(H);
        if (p0 == null || pH == null || p0 === pH) return null;
        return {
          ps: ps, H: H,
          xToIdx: function (x) { return lr._left + (x / W) * span; },
          idxToX: function (i) { return (i - lr._left) / span * W; },
          sig: lr._left + '|' + lr._right + '|' + W + '|' + H + '|' + p0 + '|' + pH
        };
      } catch (e) { return null; }
    }

    // 가격→픽셀Y 역변환기. coordinateToPrice 를 y 축으로 촘촘히 샘플링해 보간한다.
    // 선형/로그/퍼센트 등 스케일 모드와 무관하게 정확하다(선형 가정 X). 범위 밖은 양 끝 기울기로 외삽.
    function buildPriceToY(ps, H) {
      var N = 24, ys = [], pr = [];
      for (var k = 0; k <= N; k++) {
        var y = H * k / N, p = ps.coordinateToPrice(y);
        if (p == null || !isFinite(p)) return null;
        ys.push(y); pr.push(p); // pr 는 단조(위=고가, 아래=저가)
      }
      return function (price) {
        for (var k = 0; k < N; k++) {
          var a = pr[k], b = pr[k + 1];
          if ((price <= a && price >= b) || (price >= a && price <= b)) {
            return ys[k] + (price - a) / (b - a) * (ys[k + 1] - ys[k]);
          }
        }
        // 범위 밖 → 가까운 끝 구간 기울기로 외삽
        if (Math.abs(price - pr[0]) < Math.abs(price - pr[N])) {
          return ys[0] + (price - pr[0]) / (pr[1] - pr[0]) * (ys[1] - ys[0]);
        }
        return ys[N - 1] + (price - pr[N - 1]) / (pr[N] - pr[N - 1]) * (ys[N] - ys[N - 1]);
      };
    }

    // ---- 시간 ↔ 연속 index 전역 매핑 (시간대 전환·새로고침에도 위치 유지) ----
    // 점의 가로 위치를 "연속 시간(초)"로 저장하면, 시간대를 바꾸거나 새로고침해도
    // 그 시간에 해당하는 봉 위치로 다시 매핑된다. exportData 로 전체 봉 시간을 받아 구성.
    var barTimes = [];      // 오름차순 봉 시간(초)
    var tmapReady = false;
    function refreshTmap() {
      var c = chart(); if (!c || !c.exportData) return;
      try {
        var r = c.exportData({ includeTime: true, includeSeries: false });
        if (r && typeof r.then === 'function') r.then(applyTmap, function () {});
        else applyTmap(r);
      } catch (e) {}
    }
    function applyTmap(ed) {
      if (!ed || !ed.data || !ed.data.length) return;
      var arr = ed.data, t = [];
      for (var i = 0; i < arr.length; i++) { var v = arr[i]['0']; if (typeof v === 'number') t.push(v); }
      if (t.length >= 2) { barTimes = t; tmapReady = true; dirty = true; }
    }
    function iToT(i) {
      var n = barTimes.length; if (n < 2) return null;
      if (i <= 0) return barTimes[0] + i * (barTimes[1] - barTimes[0]);
      if (i >= n - 1) { var iv = barTimes[n - 1] - barTimes[n - 2]; return barTimes[n - 1] + (i - (n - 1)) * iv; }
      var k = Math.floor(i);
      return barTimes[k] + (i - k) * (barTimes[k + 1] - barTimes[k]);
    }
    function tToI(t) {
      var n = barTimes.length; if (n < 2) return null;
      if (t <= barTimes[0]) return (t - barTimes[0]) / (barTimes[1] - barTimes[0]);
      if (t >= barTimes[n - 1]) { var iv = barTimes[n - 1] - barTimes[n - 2]; return (n - 1) + (t - barTimes[n - 1]) / iv; }
      var lo = 0, hi = n - 1;
      while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (barTimes[mid] <= t) lo = mid; else hi = mid; }
      return lo + (t - barTimes[lo]) / (barTimes[lo + 1] - barTimes[lo]);
    }
    // 점의 연속 index 반환: 시간 기반(t)이면 매핑, 아니면 저장된 index(i, 레거시/그리는중).
    function ptIndex(pt) {
      if (pt.t != null) { var i = tToI(pt.t); return (i == null) ? pt.i : i; }
      return pt.i;
    }

    // ---- 캔버스: 항상 존재. 그린 선을 직접 렌더하고, 펜 ON 일 때만 입력을 가로챈다 ----
    function ensureOverlay() {
      if (overlay) return overlay;
      overlay = document.createElement('canvas');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483646',
        'background:transparent', 'touch-action:none',
        'pointer-events:none', 'cursor:crosshair'
      ].join(';');
      overlay.addEventListener('pointerdown', onPointerDown, true);
      overlay.addEventListener('pointermove', onPointerMove, true);
      overlay.addEventListener('pointerup', onPointerUp, true);
      overlay.addEventListener('pointercancel', onPointerUp, true);
      overlay.addEventListener('wheel', onWheel, { passive: false });
      overlay.addEventListener('contextmenu', function (e) { if (mode !== 'off') e.preventDefault(); });
      overlay.addEventListener('pointerleave', function () { if (eraserPos) { eraserPos = null; dirty = true; } });
      overlay.id = '__tossPenOverlay__'; // top 프레임이 캡처 시 찾을 수 있도록
      (document.body || document.documentElement).appendChild(overlay);
      ctx2d = overlay.getContext('2d');
      resizeCanvas();
      window.addEventListener('resize', function () { resizeCanvas(); dirty = true; });
      startRaf();
      return overlay;
    }

    function resizeCanvas() {
      if (!overlay) return;
      dpr = window.devicePixelRatio || 1;
      overlay.width = Math.floor(window.innerWidth * dpr);
      overlay.height = Math.floor(window.innerHeight * dpr);
      overlay.style.width = window.innerWidth + 'px';
      overlay.style.height = window.innerHeight + 'px';
      if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // 펜 ON: 입력 가로챔(차트 조작 차단). OFF: 통과(차트 정상) — 단 그린 선은 계속 보임.
    function setPenActive(on) {
      ensureOverlay();
      overlay.style.pointerEvents = on ? 'auto' : 'none';
      dirty = true;
    }

    // ---- 렌더 루프 (뷰가 바뀌거나 그리는 중일 때만 다시 그림) ----
    function startRaf() { if (!rafOn) { rafOn = true; requestAnimationFrame(tick); } }
    function tick() {
      var p = proj();
      if (p && ctx2d && (p.sig !== lastSig || dirty || cur)) {
        lastSig = p.sig; dirty = false;
        render(p);
      }
      requestAnimationFrame(tick);
    }
    function render(p) {
      ctx2d.clearRect(0, 0, window.innerWidth, window.innerHeight);
      var priceToY = buildPriceToY(p.ps, p.H);
      if (priceToY) {
        for (var i = 0; i < strokes.length; i++) drawStroke(p, priceToY, strokes[i]);
        if (cur) drawStroke(p, priceToY, cur);
      }
      // 지우개 커서(반경 표시)
      if (mode === 'eraser' && eraserPos) {
        ctx2d.beginPath();
        ctx2d.arc(eraserPos.x, eraserPos.y, ERASER_R, 0, Math.PI * 2);
        ctx2d.fillStyle = 'rgba(120,130,145,0.15)';
        ctx2d.strokeStyle = 'rgba(90,100,115,0.9)';
        ctx2d.lineWidth = 1.5;
        ctx2d.fill(); ctx2d.stroke();
      }
    }
    function drawStroke(p, priceToY, s) {
      if (!s || !s.pts || s.pts.length < 2) return;
      ctx2d.lineJoin = 'round'; ctx2d.lineCap = 'round';
      ctx2d.strokeStyle = s.color; ctx2d.lineWidth = s.width;
      ctx2d.beginPath();
      for (var i = 0; i < s.pts.length; i++) {
        var x = p.idxToX(ptIndex(s.pts[i])), y = priceToY(s.pts[i].p);
        if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();
    }

    // ---- 입력 처리 ----
    // 펜 모드: 좌클릭 드래그로 그림. 지우개 모드 또는 우클릭: 지나는 선을 지움.
    function onPointerDown(e) {
      if (mode === 'off') return;
      var p = proj(); if (!p) return;
      e.preventDefault(); e.stopPropagation();
      if (e.button === 2 || mode === 'eraser') {   // 우클릭 또는 지우개 → 지우기
        erasing = true;
        eraseAt(e.clientX, e.clientY);
        return;
      }
      cur = { color: style.color, width: style.width,
              pts: [{ i: p.xToIdx(e.clientX), p: p.ps.coordinateToPrice(e.clientY) }] };
    }
    function onPointerMove(e) {
      if (mode === 'eraser') { eraserPos = { x: e.clientX, y: e.clientY }; dirty = true; }
      if (erasing) { eraseAt(e.clientX, e.clientY); return; }
      if (!cur) return;
      var p = proj(); if (!p) return;
      e.preventDefault();
      cur.pts.push({ i: p.xToIdx(e.clientX), p: p.ps.coordinateToPrice(e.clientY) });
    }
    // 펜/지우개 모드면 오버레이가 휠까지 가로채 차트 줌/스크롤이 막힘 → 휠을 아래 차트로 전달.
    function onWheel(e) {
      e.preventDefault();
      overlay.style.pointerEvents = 'none';            // 잠깐 통과시켜 아래 요소 탐색
      var el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = (mode !== 'off') ? 'auto' : 'none';
      if (el) {
        el.dispatchEvent(new WheelEvent('wheel', {
          deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode,
          clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true
        }));
      }
    }

    // 부분 지우개: (cx,cy) 반경 ERASER_R 안의 점들을 제거하고, 선을 그 지점에서 끊어
    // 남은 구간들을 별도 선으로 분리한다 (그리기처럼 지나간 자리만 지워짐).
    function eraseAt(cx, cy) {
      var p = proj(); if (!p) return;
      var priceToY = buildPriceToY(p.ps, p.H); if (!priceToY) return;
      var next = [], changed = false;
      for (var s = 0; s < strokes.length; s++) {
        var st = strokes[s], pts = st.pts, runs = [], run = [];
        for (var i = 0; i < pts.length; i++) {
          var x = p.idxToX(ptIndex(pts[i])), y = priceToY(pts[i].p);
          if (Math.hypot(cx - x, cy - y) <= ERASER_R) {
            changed = true;
            if (run.length >= 2) runs.push(run);
            run = [];
          } else {
            run.push(pts[i]);
          }
        }
        if (run.length >= 2) runs.push(run);
        if (runs.length === 1 && runs[0].length === pts.length) {
          next.push(st); // 변화 없음
        } else {
          for (var k = 0; k < runs.length; k++) next.push({ color: st.color, width: st.width, pts: runs[k] });
        }
      }
      if (changed) { strokes = next; dirty = true; eraseChanged = true; }
    }

    function onPointerUp(e) {
      if (erasing) {
        erasing = false;
        if (eraseChanged) { eraseChanged = false; changed(); } // 드래그 끝나면 한 번만 기록·저장
        return;
      }
      if (!cur) return;
      if (cur.pts.length >= 2) {
        // 그리는 중엔 연속 index(i)로 잡았다가, 떼는 순간 시간(t)으로 변환해 저장.
        // 시간 기준이라 시간대 전환·새로고침에도 같은 위치에 다시 매핑된다.
        if (tmapReady) {
          for (var i = 0; i < cur.pts.length; i++) {
            var t = iToT(cur.pts[i].i);
            if (t != null) { cur.pts[i].t = t; delete cur.pts[i].i; }
          }
        }
        strokes.push(cur);
        changed();
      }
      cur = null; dirty = true;
    }

    // ---- 명령 처리 + Undo/Redo 히스토리 (스냅샷 기반) ----
    var history = [];   // strokes 스냅샷 목록
    var histIdx = -1;
    var HIST_MAX = 60;
    function snap() { try { return JSON.parse(JSON.stringify(strokes)); } catch (e) { return []; } }
    function snapAt(i) { try { return JSON.parse(JSON.stringify(history[i])); } catch (e) { return []; } }
    function record() {
      history = history.slice(0, histIdx + 1);
      history.push(snap());
      if (history.length > HIST_MAX) history.shift();
      histIdx = history.length - 1;
    }
    function resetHistory() { history = [snap()]; histIdx = 0; }
    function changed() { record(); dirty = true; notifyChange(); } // 변경 확정(기록+저장+다시그림)

    function undo() { if (histIdx > 0) { histIdx--; strokes = snapAt(histIdx); dirty = true; notifyChange(); } }
    function redo() { if (histIdx < history.length - 1) { histIdx++; strokes = snapAt(histIdx); dirty = true; notifyChange(); } }

    function clearAll() { strokes = []; changed(); }
    function setStrokes(saved) {
      strokes = [];
      for (var i = 0; i < (saved || []).length; i++) {
        var s = saved[i];
        if (s && s.pts && s.pts.length >= 2) {
          strokes.push({ color: s.color || '#FF3B30', width: s.width || 3, pts: s.pts });
        }
      }
      resetHistory();   // 종목/시간대 로드 시 히스토리 초기화
      dirty = true;
    }

    // 변경 사항을 top 으로 보고 → top 이 현재 종목 키로 localStorage 저장
    function notifyChange() {
      postTo(window.top, 'toToolbar', { evt: 'shapesChanged', token: currentToken, shapes: strokes });
    }

    // ---- 메시지 수신 ----
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.source !== NS || d.dir !== 'toTradingView') return;
      switch (d.cmd) {
        case 'setMode':
          mode = d.mode || 'off';
          if (d.color) style.color = d.color;
          if (d.width) style.width = d.width;
          if (mode !== 'eraser') eraserPos = null;
          setPenActive(mode !== 'off');
          if (overlay) overlay.style.cursor = 'crosshair';
          break;
        case 'setStyle':
          if (d.color) style.color = d.color;
          if (d.width) style.width = d.width;
          break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
        case 'clearAll': clearAll(); break;
        case 'loadStrokes':
          currentToken = d.token;
          setStrokes(d.shapes);
          break;
      }
    });

    // ---- 단축키 (iframe 포커스 시): Alt+D 토글, 펜/지우개 모드에서 Undo/Redo ----
    window.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        postTo(window.top, 'toToolbar', { evt: 'requestToggle' });
        return;
      }
      if (mode === 'off') return; // 펜/지우개 모드일 때만 가로챔
      var k = (e.key || '').toLowerCase(), mod = e.metaKey || e.ctrlKey;
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && k === 'y') { e.preventDefault(); redo(); }
    }, true);

    // ---- 시간대(해상도) 추적: 그림은 시간대별로 따로 저장/표시한다 ----
    // 해상도가 바뀌면 현재 선을 비우고 top 에 알려 해당 시간대의 그림을 다시 받는다.
    var curRes = null;
    function checkResolution() {
      var c = chart(); if (!c) return;
      var r;
      try { r = c.resolution(); } catch (e) { return; }
      if (r && r !== curRes) {
        curRes = r;
        strokes = []; cur = null; dirty = true; // 이전 시간대 그림 즉시 제거(잘못된 위치 깜빡임 방지)
        refreshTmap();
        postTo(window.top, 'toToolbar', { evt: 'resolution', res: r });
      }
    }

    ensureOverlay();
    refreshTmap(); // 봉 시간 매핑 초기 구성
    try {
      var c0 = chart();
      if (c0 && c0.onIntervalChanged) c0.onIntervalChanged().subscribe(null, checkResolution);
    } catch (e) {}
    // 실시간 신규 봉 반영 + 해상도 변경 감지(안전망)
    setInterval(function () { refreshTmap(); checkResolution(); }, 3000);
    postTo(window.top, 'toToolbar', { evt: 'ready' });
    checkResolution(); // 초기 해상도 보고 → top 이 해당 시간대 그림 로드
  }

  // =========================================================================
  // 툴바 역할 (최상위 프레임)
  // =========================================================================
  function initToolbar() {
    var COLORS = ['#F04452', '#3182F6', '#15B881', '#FF9500', '#191F28'];
    var WIDTHS = [2, 3, 5];

    var engineWindow = null;
    var currentSymbol = symbolFromUrl();
    var currentRes = null;   // 엔진이 보고한 현재 시간대(해상도)
    var loadToken = 0;
    var mode = 'off';   // 'off' | 'pen' | 'eraser'
    var ui = null;

    // ---- UI 환경설정 (색·굵기) 유지 ----
    var pref = loadPref();
    var style = {
      color: COLORS.indexOf(pref.color) >= 0 ? pref.color : COLORS[0],
      width: WIDTHS.indexOf(pref.width) >= 0 ? pref.width : WIDTHS[1]
    };
    function loadPref() {
      try { return JSON.parse(localStorage.getItem('__tossPen_ui__') || '{}') || {}; }
      catch (e) { return {}; }
    }
    function savePref() {
      try {
        localStorage.setItem('__tossPen_ui__', JSON.stringify({
          color: style.color, width: style.width, left: pref.left, top: pref.top
        }));
      } catch (e) {}
    }

    // ---- localStorage (종목 + 시간대별 그림) ----
    // 키를 종목과 해상도(시간대)로 분리 → 1분/15분/일/주/… 각각 따로 그려지고 저장된다.
    function keyFor(sym, res) { return '__tossPen__' + (sym || 'unknown') + '__' + (res || '?'); }
    function loadDrawings(sym, res) {
      try { return JSON.parse(localStorage.getItem(keyFor(sym, res)) || '[]'); }
      catch (e) { return []; }
    }
    function saveDrawings(sym, res, arr) {
      try { localStorage.setItem(keyFor(sym, res), JSON.stringify(arr || [])); } catch (e) {}
    }
    // 이 종목의 모든 시간대 버킷 제거
    function clearAllTimeframes() {
      try {
        var prefix = '__tossPen__' + (currentSymbol || 'unknown') + '__';
        var rm = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(prefix) === 0) rm.push(k);
        }
        for (var j = 0; j < rm.length; j++) localStorage.removeItem(rm[j]);
      } catch (e) {}
    }
    function symbolFromUrl() {
      var m = location.pathname.match(/\/stocks\/([^/?#]+)/);
      return m ? m[1] : null;
    }

    // ---- 엔진으로 명령 ----
    function send(payload) { postTo(engineWindow, 'toTradingView', payload); }

    // 현재 (종목, 시간대) 버킷의 그림을 엔진에 보낸다. 해상도를 아직 모르면 보류.
    function sendLoad() {
      currentSymbol = symbolFromUrl();
      if (!currentRes) return;
      loadToken++;
      send({ cmd: 'loadStrokes', token: loadToken, shapes: loadDrawings(currentSymbol, currentRes) });
    }

    function setMode(m) {
      mode = m;
      send({ cmd: 'setMode', mode: mode, color: style.color, width: style.width });
      renderState();
    }
    function togglePen() { setMode(mode === 'pen' ? 'off' : 'pen'); }
    function toggleEraser() { setMode(mode === 'eraser' ? 'off' : 'eraser'); }

    function applyStyle() {
      send({ cmd: 'setStyle', color: style.color, width: style.width });
      savePref();
      renderState();
    }

    // ---- 메시지 수신 (엔진 → 툴바) ----
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.source !== NS || d.dir !== 'toToolbar') return;
      switch (d.evt) {
        case 'ready':
          engineWindow = e.source;
          setStatus('');
          // 모드 동기화. 그림 로드는 엔진의 'resolution' 보고를 받고 진행.
          send({ cmd: 'setMode', mode: mode, color: style.color, width: style.width });
          break;
        case 'resolution':
          engineWindow = e.source;
          currentRes = d.res;
          sendLoad(); // 해당 시간대의 그림 로드
          break;
        case 'shapesChanged':
          // 토큰 일치할 때만 현재 (종목, 시간대) 버킷에 저장
          if (d.token === loadToken) saveDrawings(currentSymbol, currentRes, d.shapes);
          break;
        case 'requestToggle':
          togglePen();
          break;
        case 'error':
          setStatus('차트 호환 안 됨');
          break;
      }
    });

    // ---- SPA 종목 전환 감지 ----
    function onUrlMaybeChanged() {
      var sym = symbolFromUrl();
      if (sym && sym !== currentSymbol) {
        currentSymbol = sym;
        sendLoad(); // 새 종목(현재 시간대) 그림으로 교체
      }
      place(); // 네비바가 새로 렌더되었을 수 있으니 재배치
    }
    patchHistory(onUrlMaybeChanged);
    window.addEventListener('popstate', onUrlMaybeChanged);

    // ---- 단축키 (top 포커스): Alt+D 토글, 펜/지우개 모드에서 Undo/Redo ----
    window.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        togglePen();
        return;
      }
      if (mode === 'off') return; // 펜/지우개 모드일 때만 가로챔
      var k = (e.key || '').toLowerCase(), mod = e.metaKey || e.ctrlKey;
      if (mod && k === 'z') { e.preventDefault(); send({ cmd: e.shiftKey ? 'redo' : 'undo' }); }
      else if (mod && k === 'y') { e.preventDefault(); send({ cmd: 'redo' }); }
    }, true);

    // 엔진이 일정 시간 내 응답 없으면 안내 (차트 미탑재 페이지 등)
    setTimeout(function () {
      if (!engineWindow) setStatus('차트 대기 중…');
    }, 12000);

    // ---- UI 구성 (Shadow DOM) + 네비바 도킹 ----
    // 네비바 메뉴(GNBControl: 홈/피드/주식 골라보기/내 계좌) 의 마지막 자식으로 끼운다.
    // → "내 계좌" 오른쪽 빈 영역에 배치되어 우측 관심목록 패널과 충돌하지 않음.
    var DOCK_SEL = '[data-list-name="GNBControl"]';

    buildToolbar();
    place();
    window.addEventListener('resize', place);
    // 네비바 재렌더/크게보기 진입·이탈 등에 대응해 주기적으로 배치 재평가(저비용).
    setInterval(place, 1000);

    // 도킹 대상이 실제로 화면에 보이는지(존재+크기+가려지지 않음) 판정.
    // 크게보기 같은 전체화면 오버레이가 GNBControl 을 덮으면 false → 플로팅으로 전환.
    function dockUsable(dock) {
      if (!dock || dock.offsetParent === null) return false;
      var r = dock.getBoundingClientRect();
      if (r.width < 10 || r.height < 10 || r.bottom <= 0 || r.top >= window.innerHeight) return false;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var top = document.elementFromPoint(cx, cy);
      // dock(또는 그 안의 우리 host)이 그 지점의 최상단이어야 "보임". 아니면 무언가에 가려진 것.
      return !!(top && (dock.contains(top) || top.contains(dock)));
    }

    // 배치: GNB 메뉴 끝 인라인(보일 때). 가려지거나 없거나 넘치면 화면 위로 띄움(드래그 가능).
    // ui._placed 로 현재 상태를 추적해 매초 재평가 시 불필요한 재배치(깜빡임)를 막는다.
    function place() {
      if (!ui || !ui.host) return;
      var dock = document.querySelector(DOCK_SEL);
      var canDock = dock && dockUsable(dock);
      if (canDock) {
        if (ui._placed !== 'dock' || ui.host.parentElement !== dock) {
          dock.appendChild(ui.host);
          ui.host.style.cssText = 'all:initial;display:inline-flex;align-items:center;margin-left:8px;';
          ui.bar.classList.remove('floatmode');
          ui._placed = 'dock';
        }
      } else {
        if (ui._placed !== 'float' || ui.host.parentElement !== document.body) floatFree();
      }
    }
    function floatFree() {
      if (ui.host.parentElement !== document.body) {
        (document.body || document.documentElement).appendChild(ui.host);
      }
      ui.bar.classList.add('floatmode');
      // 바 너비를 재어 화면 안에 들어오도록 위치 계산
      ui.host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;';
      var bw = Math.round(ui.bar.getBoundingClientRect().width) || 420;
      var left = (typeof pref.left === 'number') ? clampNum(pref.left, 0, window.innerWidth - bw - 4) : (window.innerWidth - bw - 16);
      var top = (typeof pref.top === 'number') ? clampNum(pref.top, 0, window.innerHeight - 40) : 64;
      ui.host.style.cssText = 'all:initial;position:fixed;left:' + left + 'px;top:' + top + 'px;z-index:2147483647;';
      ui._placed = 'float';
      bindDrag();
    }
    function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    // 플로팅 시 grip 으로 드래그 이동 (위치는 pref 에 저장)
    function bindDrag() {
      if (ui._dragBound || !ui.grip) return;
      ui._dragBound = true;
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      ui.grip.addEventListener('pointerdown', function (e) {
        if (!ui.bar.classList.contains('floatmode')) return;
        dragging = true; sx = e.clientX; sy = e.clientY;
        var r = ui.host.getBoundingClientRect(); ox = r.left; oy = r.top;
        try { ui.grip.setPointerCapture(e.pointerId); } catch (er) {}
        e.preventDefault();
      });
      ui.grip.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        var nl = clampNum(ox + e.clientX - sx, 0, window.innerWidth - 80);
        var nt = clampNum(oy + e.clientY - sy, 0, window.innerHeight - 40);
        ui.host.style.left = nl + 'px'; ui.host.style.top = nt + 'px';
        pref.left = nl; pref.top = nt;
      });
      ui.grip.addEventListener('pointerup', function (e) {
        dragging = false;
        try { ui.grip.releasePointerCapture(e.pointerId); } catch (er) {}
        savePref();
      });
    }

    function buildToolbar() {
      var host = document.createElement('div');
      host.id = '__toss_pen_host__';
      host.style.cssText = 'all:initial';
      var shadow = host.attachShadow({ mode: 'open' });

      var styleEl = document.createElement('style');
      styleEl.textContent = CSS;
      shadow.appendChild(styleEl);

      var bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = HTML(COLORS, WIDTHS);
      shadow.appendChild(bar);

      ui = {
        host: host,
        bar: bar,
        grip: bar.querySelector('.grip'),
        penBtn: bar.querySelector('.brand'),
        eraserBtn: bar.querySelector('.eraser'),
        status: bar.querySelector('.status'),
        swatches: bar.querySelectorAll('.swatch'),
        widthBtns: bar.querySelectorAll('.w')
      };

      ui.penBtn.addEventListener('click', togglePen);
      ui.eraserBtn.addEventListener('click', toggleEraser);
      bar.querySelector('.capture').addEventListener('click', captureToClipboard);
      bar.querySelector('.undo').addEventListener('click', function () { send({ cmd: 'undo' }); });
      // 현재 시간대 그림만 삭제
      bar.querySelector('.clearcur').addEventListener('click', function () {
        if (confirm('현재 시간대의 그림을 모두 삭제할까요?')) send({ cmd: 'clearAll' });
      });
      // 이 종목의 모든 시간대 그림 삭제
      bar.querySelector('.clearall').addEventListener('click', function () {
        if (confirm('이 종목의 모든 시간대 그림을 삭제할까요?')) {
          clearAllTimeframes();
          send({ cmd: 'clearAll' });
        }
      });

      // 색/굵기 선택 → 상태 변경 + 엔진에 적용
      ui.swatches.forEach(function (sw) {
        sw.addEventListener('click', function () {
          style.color = sw.dataset.color; applyStyle();
        });
      });
      ui.widthBtns.forEach(function (wb) {
        wb.addEventListener('click', function () {
          style.width = parseInt(wb.dataset.w, 10); applyStyle();
        });
      });

      renderState();
    }

    // 배경색 대비 위해 밝은 색이면 어두운 글자색 반환
    function textOn(hex) {
      var h = (hex || '').replace('#', '');
      if (h.length !== 6) return '#fff';
      var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return lum > 0.6 ? '#191F28' : '#fff';
    }
    // hex → rgba 문자열 (글로우용)
    function rgba(hex, a) {
      var h = (hex || '').replace('#', '');
      if (h.length !== 6) return 'rgba(49,130,246,' + a + ')';
      var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    function renderState() {
      if (!ui) return;
      var pen = (mode === 'pen');
      // 펜 토글(=brand 아이콘 버튼): 펜 모드면 현재 색으로 채우고 글로우
      ui.penBtn.classList.toggle('on', pen);
      ui.penBtn.title = (pen ? '펜 끄기' : '펜 켜기') + ' (Alt+D)';
      ui.penBtn.style.background = pen ? style.color : '';
      ui.penBtn.style.color = pen ? textOn(style.color) : '';
      ui.penBtn.style.boxShadow = pen ? '0 0 0 3px ' + rgba(style.color, 0.18) : '';
      // 지우개 토글
      if (ui.eraserBtn) ui.eraserBtn.classList.toggle('on', mode === 'eraser');

      ui.swatches.forEach(function (sw) {
        sw.classList.toggle('active', sw.dataset.color === style.color);
      });
      ui.widthBtns.forEach(function (wb) {
        wb.classList.toggle('active', parseInt(wb.dataset.w, 10) === style.width);
      });
    }

    function setStatus(text) {
      if (ui && ui.status) {
        ui.status.textContent = text || '';
        ui.status.style.display = text ? 'inline' : 'none';
      }
    }
    var statusTimer = null;
    function flashStatus(text, ok) {
      setStatus(text);
      if (ui && ui.status) ui.status.style.color = ok ? '#15B881' : '#F04452';
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(function () { setStatus(''); if (ui && ui.status) ui.status.style.color = ''; }, 1600);
    }

    // 차트(iframe 캔버스들) + 우리 그림 오버레이를 합성해 PNG 로 클립보드 복사.
    // 같은 출처라 top 에서 iframe 캔버스를 읽을 수 있고, 클릭 제스처가 top 에 있어 클립보드 쓰기 허용됨.
    function captureToClipboard() {
      try {
        var ifr = document.querySelector('iframe[id^="tradingview_"]');
        var idoc = ifr && ifr.contentDocument, iwin = ifr && ifr.contentWindow;
        if (!idoc || !iwin) { flashStatus('차트 없음'); return; }
        var dpr = iwin.devicePixelRatio || 1;
        var out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(iwin.innerWidth * dpr));
        out.height = Math.max(1, Math.round(iwin.innerHeight * dpr));
        var g = out.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, out.width, out.height);
        var overlay = idoc.getElementById('__tossPenOverlay__');
        var cvs = idoc.querySelectorAll('canvas');
        for (var i = 0; i < cvs.length; i++) {
          if (cvs[i] === overlay) continue;
          var r = cvs[i].getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          try { g.drawImage(cvs[i], r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr); } catch (e) {}
        }
        if (overlay) {
          var orr = overlay.getBoundingClientRect();
          try { g.drawImage(overlay, orr.left * dpr, orr.top * dpr, orr.width * dpr, orr.height * dpr); } catch (e) {}
        }
        if (!(navigator.clipboard && window.ClipboardItem)) { flashStatus('클립보드 미지원'); return; }
        var blobP = new Promise(function (res, rej) {
          out.toBlob(function (b) { b ? res(b) : rej(new Error('blob')); }, 'image/png');
        });
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })])
          .then(function () { flashStatus('복사됨 ✓', true); })
          .catch(function () { flashStatus('복사 실패'); });
      } catch (e) {
        flashStatus('캡처 실패');
      }
    }
  }

  // =========================================================================
  // 유틸: history 패치 / 드래그 / UI 템플릿
  // =========================================================================
  function patchHistory(cb) {
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (!orig || orig.__tossPatched) return;
      var wrapped = function () {
        var r = orig.apply(this, arguments);
        try { cb(); } catch (e) {}
        return r;
      };
      wrapped.__tossPatched = true;
      history[m] = wrapped;
    });
  }

  var PEN_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var UNDO_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
  var ERASER_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.3-9.3a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/>' +
    '<path d="M22 21H7"/><path d="m5 11 9 9"/></svg>';
  var CAM_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>' +
    '<circle cx="12" cy="13" r="3"/></svg>';

  // 가로배치 인라인 툴바 (네비바 우측에 끼움)
  function HTML(colors, widths) {
    var sw = colors.map(function (c) {
      return '<button class="swatch" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>';
    }).join('');
    var ws = widths.map(function (w) {
      return '<button class="w" data-w="' + w + '" title="' + w + 'px"><i style="height:' + w + 'px"></i></button>';
    }).join('');
    return '' +
      '<span class="grip" title="드래그하여 이동" aria-hidden="true">⠿</span>' +
      '<button class="brand" title="펜 켜기/끄기 (Alt+D)" aria-label="펜 켜기/끄기">' + PEN_SVG + '</button>' +
      '<span class="sep"></span>' +
      '<div class="colors">' + sw + '</div>' +
      '<span class="sep"></span>' +
      '<div class="wgroup">' + ws + '</div>' +
      '<span class="sep"></span>' +
      '<button class="act capture" title="차트+그림 캡처 (클립보드 복사)" aria-label="캡처">' + CAM_SVG + '</button>' +
      '<button class="act eraser" title="지우개 (드래그·우클릭으로 선 지우기)" aria-label="지우개">' + ERASER_SVG + '</button>' +
      '<button class="act undo" title="되돌리기" aria-label="되돌리기">' + UNDO_SVG + '</button>' +
      '<button class="act clearcur" title="현재 시간대 전체 삭제" aria-label="현재 시간대 전체 삭제">' + TRASH_SVG + '</button>' +
      '<button class="act clearall" title="모든 시간대 삭제" aria-label="모든 시간대 삭제">' + TRASH_SVG + '</button>' +
      '<span class="status"></span>';
  }

  var CSS = '' +
    '*{box-sizing:border-box;}' +
    '.bar{display:inline-flex;align-items:center;gap:5px;height:34px;padding:0 6px;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;' +
    'background:#fff;color:#191F28;border-radius:11px;white-space:nowrap;-webkit-font-smoothing:antialiased;' +
    'box-shadow:0 1px 4px rgba(17,24,39,.12),0 0 0 1px rgba(17,24,39,.07);}' +
    '.bar.floatmode{box-shadow:0 8px 28px rgba(17,24,39,.18),0 0 0 1px rgba(17,24,39,.06);}' +
    '.grip{display:none;align-items:center;justify-content:center;width:14px;height:28px;flex:none;' +
    'color:#B0B8C1;cursor:move;font-size:13px;user-select:none;touch-action:none;}' +
    '.bar.floatmode .grip{display:flex;}' +
    '.sep{width:1px;height:18px;background:#E5E8EB;flex:none;}' +
    '.brand{width:26px;height:26px;border-radius:7px;border:none;padding:0;flex:none;cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;background:#F2F4F6;color:#8B95A1;' +
    'transition:background .15s,color .15s,box-shadow .15s;}' +
    '.brand:hover{background:#E8EBED;color:#4E5968;}' +
    '.brand.on:hover{filter:brightness(.97);}' +
    '.colors{display:flex;align-items:center;gap:5px;}' +
    '.swatch{width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1.5px #E5E8EB;' +
    'cursor:pointer;padding:0;flex:none;transition:transform .12s;}' +
    '.swatch:hover{transform:scale(1.15);}' +
    '.swatch.active{box-shadow:0 0 0 2px #fff,0 0 0 3px #191F28;}' +
    '.wgroup{display:flex;align-items:center;background:#F2F4F6;border-radius:8px;padding:2px;gap:2px;}' +
    '.w{width:24px;height:22px;border:none;background:transparent;border-radius:6px;cursor:pointer;padding:0;' +
    'display:flex;align-items:center;justify-content:center;transition:background .12s;}' +
    '.w i{display:block;width:13px;border-radius:99px;background:#8B95A1;}' +
    '.w:hover i{background:#6B7684;}' +
    '.w.active{background:#fff;box-shadow:0 1px 3px rgba(17,24,39,.14);}' +
    '.w.active i{background:#191F28;}' +
    '.act{width:26px;height:26px;border-radius:7px;border:none;background:transparent;cursor:pointer;color:#6B7684;' +
    'display:flex;align-items:center;justify-content:center;padding:0;flex:none;transition:background .12s,color .12s;}' +
    '.act:hover{background:#F2F4F6;}' +
    '.act.eraser.on{background:#191F28;color:#fff;}' +
    '.act.clearall{color:#F04452;}' +
    '.act.clearall:hover{background:#FDECEE;}' +
    '.status{font-size:10px;color:#F04452;font-weight:700;display:none;padding-left:2px;}';

  // ---- 역할 분기 실행 (모든 함수/상수 정의 이후) ----
  if (isTop) {
    initToolbar();
  } else {
    initEngineWhenReady();
  }

})();
