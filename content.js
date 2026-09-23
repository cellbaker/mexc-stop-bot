(function () {
  'use strict';

  /* =========================================================================
   *  НАСТРОЙКИ
   * ========================================================================= */
  const CONFIG = {
    PROFIT_LEVELS: [10, 15, 25],   // уровни кнопок, % ROI с плечом
    BU_FEE_BUFFER: 0.0008,         // буфер БУ на комиссию (0.0008 = 0.08%); 0 = чистый вход
    DEFAULT_LEVERAGE: 10,          // запасное плечо, если не считалось
    AUTO_CONFIRM: true,            // сам жмёт "Confirm" в форме TP/SL (false = впишет цену, подтверждаешь ты)
    AUTO_CONFIRM_WARNINGS: true,   // авто-Confirm на варнинге "цена слишком близка" и подобных
    PRICE_DECIMALS: 'auto',        // 'auto' = из цены входа
    HOTKEYS: true,                 // Alt+B = БУ, Alt+1/2/3 = уровни
  };

  // Панель показываем только на торговых страницах фьючерсов
  const IS_FUTURES = /futures|exchange|swap/i.test(location.href) || location.hostname === 'futures.mexc.com';

  /* =========================================================================
   *  ПЕРЕХВАТ ДАННЫХ БИРЖИ  (WebSocket + fetch + XHR)
   * ========================================================================= */
  const positions = new Map();
  const rawFrames = [];

  function looksLikePosition(o) {
    return o && typeof o === 'object' && !Array.isArray(o)
      && ('positionType' in o || 'posType' in o)
      && ('leverage' in o)
      && ('holdAvgPrice' in o || 'openAvgPrice' in o || 'holdAvgPriceFair' in o);
  }

  function scanForPositions(obj, out, seen, depth) {
    if (!obj || typeof obj !== 'object' || depth > 8) return;
    if (seen.has(obj)) return; seen.add(obj);
    if (Array.isArray(obj)) { for (const x of obj) scanForPositions(x, out, seen, depth + 1); return; }
    if (looksLikePosition(obj)) out.push(obj);
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') scanForPositions(v, out, seen, depth + 1);
    }
  }

  function mapPosition(o) {
    const entry = parseFloat(o.holdAvgPrice ?? o.openAvgPrice ?? o.holdAvgPriceFair);
    const ptype = Number(o.positionType ?? o.posType);
    const vol   = parseFloat(o.holdVol ?? o.vol ?? o.holdVolume ?? 0);
    return {
      symbol: o.symbol || o.symbolName || '',
      side: ptype === 2 ? 'short' : 'long',
      entry,
      leverage: parseFloat(o.leverage) || CONFIG.DEFAULT_LEVERAGE,
      vol,
      ts: Date.now(),
    };
  }

  function ingest(text) {
    if (typeof text !== 'string' || text.length < 10) return;
    if (!/positionType|posType|holdAvgPrice|leverage/.test(text)) return;
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    const found = [];
    scanForPositions(data, found, new Set(), 0);
    if (!found.length) return;
    if (rawFrames.length < 30) rawFrames.push(found);
    let changed = false;
    for (const raw of found) {
      const p = mapPosition(raw);
      if (!p.symbol || !(p.entry > 0)) continue;
      if (p.vol > 0) { positions.set(p.symbol, p); changed = true; }
      else if (positions.has(p.symbol)) { positions.delete(p.symbol); changed = true; }
    }
    if (changed) refreshPanel();
  }

  // --- WebSocket ---
  const OrigWS = window.WebSocket;
  function HookedWS(...args) {
    const ws = new OrigWS(...args);
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      if (typeof d === 'string') ingest(d);
      else if (d instanceof Blob) d.text().then(ingest).catch(() => {});
      else if (d instanceof ArrayBuffer) { try { ingest(new TextDecoder().decode(d)); } catch (e) {} }
    });
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { HookedWS[k] = OrigWS[k]; });
  try { window.WebSocket = HookedWS; } catch (e) {}

  // --- fetch ---
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...a) {
      return origFetch.apply(this, a).then((res) => {
        try {
          const url = String((a[0] && a[0].url) || a[0] || '');
          if (/position|open_positions/i.test(url)) res.clone().text().then(ingest).catch(() => {});
        } catch (e) {}
        return res;
      });
    };
  }

  // --- XHR ---
  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__url = u; return xOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try { if (/position|open_positions/i.test(this.__url || '')) ingest(this.responseText); } catch (e) {}
    });
    return xSend.apply(this, arguments);
  };

  /* =========================================================================
   *  ВЫБОР ТЕКУЩЕЙ ПОЗИЦИИ
   * ========================================================================= */
  function symbolFromURL() {
    const m = location.href.match(/([A-Z0-9]+_(?:USDT|USDC|USD))/);
    return m ? m[1] : null;
  }
  function currentPosition() {
    const sym = symbolFromURL();
    if (sym && positions.has(sym)) return positions.get(sym);
    let best = null;
    for (const p of positions.values()) if (!best || p.ts > best.ts) best = p;
    return best;
  }

  /* =========================================================================
   *  ХЕЛПЕРЫ DOM / ФОРМА TP/SL
   * ========================================================================= */
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function byText(re, tags = ['button', 'div', 'span', 'a']) {
    const out = [];
    for (const tag of tags) for (const el of $$(tag)) {
      const t = norm(el.textContent);
      if (t && t.length < 40 && re.test(t)) out.push(el);
    }
    return out;
  }

  function setReactInput(input, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
      || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    input.focus();
    desc.set.call(input, '');                                   // сброс
    input.dispatchEvent(new Event('input', { bubbles: true }));
    desc.set.call(input, String(value));                        // запись
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value), inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  const log = (...a) => console.log('%c[Стоп-бот]', 'color:#2563eb;font-weight:700', ...a);
  log('content.js загружен (v2.1)');

  // Полноценный клик — MEXC реагирует на pointer/mouse-события, а не на голый .click()
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, button: 0,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, o));
      } catch (e) { try { el.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), o)); } catch (e2) {} }
    }
    try { el.click(); } catch (e) {}
  }

  const dist = (a, b) => { const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return Math.hypot(x.left - y.left, x.top - y.top); };

  const decimalsOf = (s) => (String(s).match(/\.(\d+)/) || [, ''])[1].length || 2;
  const copy = (t) => { try { navigator.clipboard.writeText(t); } catch (e) {} };

  function toast(msg, ok = true) {
    let t = $('#mexcStopToast');
    if (!t) { t = document.createElement('div'); t.id = 'mexcStopToast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.cssText = `position:fixed;left:50%;top:14%;transform:translateX(-50%);z-index:2147483647;
      padding:10px 16px;border-radius:8px;font:600 13px/1.3 system-ui;color:#fff;
      background:${ok ? '#127a3d' : '#a11b1b'};box-shadow:0 6px 20px rgba(0,0,0,.4)`;
    t.style.opacity = '1';
    clearTimeout(t._tm); t._tm = setTimeout(() => (t.style.opacity = '0'), 2600);
  }

  // Кнопка "Add" в строке позиции (под колонкой TP/SL, рядом с "Reverse")
  function findAddButton() {
    const cands = byText(/^\+?\s*add$|^добавить$/i, ['button', 'a', 'span', 'div'])
      .filter(b => b.offsetParent !== null);
    if (!cands.length) return null;
    // самые внутренние элементы (без вложенных кандидатов с тем же текстом)
    const inner = cands.filter(c => !cands.some(o => o !== c && c.contains(o)));
    const list = inner.length ? inner : cands;
    // приоритет тому, что ближе к "Reverse" (это и есть Add у позиции)
    const reverse = byText(/^reverse$|^реверс$/i).find(b => b.offsetParent !== null);
    if (reverse) list.sort((a, b) => dist(a, reverse) - dist(b, reverse));
    return list[0];
  }

  function openTPSL() {
    const btn = findAddButton();
    if (!btn) { log('Кнопка Add не найдена'); return false; }
    log('Кликаю Add:', btn);
    realClick(btn);
    // некоторые сборки MEXC вешают обработчик на родителя — кликнем и по нему
    if (btn.parentElement) realClick(btn.parentElement);
    return true;
  }

  // Находим именно поле "Stop-loss → Trigger Price"
  function findSLTriggerInput() {
    const vis = (el) => el && el.offsetParent !== null && !el.disabled;
    const inputs = $$('input').filter(vis);
    if (!inputs.length) return null;

    // Поля с placeholder "Trigger Price" (одинаковы у TP и SL; SL идёт ниже по DOM)
    const trig = inputs.filter(i => /trigger\s*price|триггер|цена.?сработ/i.test(i.placeholder || ''));

    // Заголовок секции Stop-loss
    const head = $$('div,span,label,h1,h2,h3,h4,p')
      .find(e => /stop-?loss|стоп-?лосс|стоп-?убыт/i.test(norm(e.textContent)) && norm(e.textContent).length < 40);

    // Берём первый trigger-price input, который идёт ПОСЛЕ заголовка Stop-loss
    if (head && trig.length) {
      const after = trig.filter(i => head.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (after.length) return after[0];
    }
    if (trig.length >= 2) return trig[1];   // TP — первый, SL — второй
    if (trig.length === 1) return trig[0];
    if (head) {
      const after = inputs.filter(i => head.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (after.length) return after[0];    // первое поле под заголовком Stop-loss
    }
    return null;
  }

  // Возвращает заполненный input (или null)
  function fillSL(price) {
    return new Promise((resolve) => {
      let tries = 0;
      const iv = setInterval(() => {
        const target = findSLTriggerInput();
        if (target) {
          clearInterval(iv);
          log('Нашёл поле Stop-loss, пишу', price);
          setReactInput(target, price);
          setTimeout(() => resolve(target), 25);   // минимальная пауза на обновление React
        } else if (++tries > 70) { clearInterval(iv); log('Поле Stop-loss не найдено (окно не открылось?)'); resolve(null); }
      }, 35);
    });
  }

  function clickConfirm() {
    const btn = byText(/^confirm$|^ok$|^подтвердить$|^submit$|^создать$/i, ['button']).find(b => b.offsetParent !== null);
    if (btn) btn.click();
    return !!btn;
  }

  // Авто-подтверждение всплывающих варнингов после Confirm.
  // Пример: "Risk reminder — The trigger price is close to the current price..."
  // Стратегия: ищем text-node с заголовком/телом варнинга, поднимаемся к ближайшему ancestor'у,
  // в котором есть кнопка Confirm — это и есть граница вложенной модалки.
  function findWarningConfirmButton() {
    const titleRe = /^(risk reminder|reminder|warning|notice|внимание|предупрежд\w*|напомин\w* о риске)$/i;
    const bodyRe = /close to (the )?current price|too close|may be triggered|trigger.{0,30}immediately|are you sure|слишком близк|сработ\w*\s+немедленно|вы уверены/i;
    const confirmRe = /^(confirm|ok|continue|yes|подтвердить|продолжить|да)$/i;

    function climbToConfirm(el) {
      let anc = el;
      for (let i = 0; i < 10 && anc; i++) {
        const btn = $$('button', anc).find(b =>
          b.offsetParent !== null && !b.disabled && confirmRe.test(norm(b.textContent))
        );
        if (btn) return btn;
        anc = anc.parentElement;
      }
      return null;
    }

    function collectTextHits(re, maxLen) {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.textContent || '').trim();
        if (!t || t.length > maxLen) continue;
        if (re.test(t)) out.push(n.parentElement);
      }
      return out;
    }

    // 1) Точное совпадение по заголовку ("Risk reminder")
    for (const el of collectTextHits(titleRe, 40)) {
      if (!el || el.offsetParent === null) continue;
      const btn = climbToConfirm(el);
      if (btn) return btn;
    }

    // 2) Fallback — по тексту тела
    for (const el of collectTextHits(bodyRe, 300)) {
      if (!el || el.offsetParent === null) continue;
      const btn = climbToConfirm(el);
      if (btn) return btn;
    }

    return null;
  }

  function dismissWarningPopups(deadlineMs = 3500) {
    if (!CONFIG.AUTO_CONFIRM_WARNINGS) return;
    const start = Date.now();
    let clicked = false;
    const iv = setInterval(() => {
      if (Date.now() - start > deadlineMs) { clearInterval(iv); return; }
      const btn = findWarningConfirmButton();
      if (btn) {
        realClick(btn);
        clicked = true;
        log('Подтвердил варнинг:', btn);
        toast('Подтверждение риска ✓');
        // не выходим сразу — могут быть несколько подряд
      } else if (clicked) {
        // варнингов больше нет — выходим
        clearInterval(iv);
      }
    }, 180);
  }

  /* =========================================================================
   *  РАСЧЁТ + ДЕЙСТВИЕ
   * ========================================================================= */
  function calcStop(entry, side, leverage, mode, roiPct) {
    const sign = side === 'long' ? 1 : -1;
    const price = mode === 'BU'
      ? entry * (1 + sign * CONFIG.BU_FEE_BUFFER)
      : entry * (1 + sign * (roiPct / 100) / leverage);
    const dec = CONFIG.PRICE_DECIMALS === 'auto' ? decimalsOf(entry) : CONFIG.PRICE_DECIMALS;
    return Number(price.toFixed(dec));
  }

  async function applyStop(mode, roiPct) {
    const pos = currentPosition();
    if (!pos) { toast('Позиция не считана — открой позицию / обнови страницу', false); return; }

    const price = calcStop(pos.entry, pos.side, pos.leverage, mode, roiPct);
    const label = mode === 'BU' ? 'БУ' : `+${roiPct}%`;

    copy(String(price));
    $('#msResult').textContent = `${pos.symbol} ${pos.side} → Стоп ${label}: ${price} (скопировано)`;
    toast(`Стоп ${label} = ${price} — в буфере`);

    if (openTPSL()) {
      const target = await fillSL(price);
      if (target) {
        const got = parseFloat(String(target.value).replace(',', '.'));
        const landed = isFinite(got) && Math.abs(got - price) <= price * 0.0005;
        $('#msResult').textContent = `${pos.symbol} ${pos.side} → Стоп ${label}: ${price} (вписан)`;
        if (CONFIG.AUTO_CONFIRM) {
          if (landed) setTimeout(() => {
            if (clickConfirm()) {
              toast(`Стоп ${label} установлен ✓`);
              dismissWarningPopups();   // если выскочит «Risk reminder» — прожмём Confirm
            } else {
              toast('Не нашёл Confirm', false);
            }
          }, 60);
          else toast('Цена встала неточно — проверь и жми Confirm сам', false);
        } else {
          toast('Цена вписана — нажми Confirm', true);
          dismissWarningPopups();       // на случай если пользователь сам жмёт Confirm — мы поймаем варнинг
        }
      } else toast('Поле Stop-loss не нашёл — вставь цену из буфера', false);
    } else toast('Кнопку TP/SL не нашёл — вставь цену из буфера', false);
  }

  /* =========================================================================
   *  ПАНЕЛЬ
   * ========================================================================= */
  function buildPanel() {
    if ($('#mexcStopPanel')) return;
    injectStyles();
    const saved = JSON.parse(localStorage.getItem('mexcStop') || '{}');
    const p = document.createElement('div');
    p.id = 'mexcStopPanel';
    p.innerHTML = `
      <div id="msHead"><span id="msDot"></span> Стоп-бот MEXC <span id="msClose">✕</span></div>
      <div id="msInfo">жду данные позиции…</div>
      <div class="msBtns">
        <button class="msAct bu" data-mode="BU">Стоп в БУ</button>
        ${CONFIG.PROFIT_LEVELS.map(l => `<button class="msAct" data-roi="${l}">+${l}%</button>`).join('')}
      </div>
      <div id="msResult">—</div>
      <div id="msCredit">Created by <b>@cellbaker</b></div>`;
    document.body.appendChild(p);
    p.style.left = saved.x || '20px';
    p.style.top  = saved.y || '120px';

    $('#msClose').onclick = () => p.remove();
    $$('.msAct', p).forEach(b => b.onclick = () =>
      b.dataset.mode === 'BU' ? applyStop('BU') : applyStop('ROI', parseFloat(b.dataset.roi)));

    makeDraggable(p, $('#msHead'));
    refreshPanel();
    setInterval(refreshPanel, 1500);
  }

  function refreshPanel() {
    const info = $('#msInfo'); const dot = $('#msDot');
    if (!info) return;
    const pos = currentPosition();
    if (pos) {
      dot.style.background = '#36c46a';
      info.innerHTML = `<b>${pos.symbol}</b> · <span class="${pos.side}">${pos.side === 'long' ? 'Long' : 'Short'}</span>
        · вход <b>${pos.entry}</b> · <b>${pos.leverage}x</b>`;
    } else {
      dot.style.background = '#c4503a';
      info.textContent = 'нет открытой позиции (или данные ещё не пришли)';
    }
  }

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', e => {
      if (e.target.id === 'msClose') return;
      drag = true; sx = e.clientX; sy = e.clientY; ox = panel.offsetLeft; oy = panel.offsetTop; e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top  = (oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return; drag = false;
      localStorage.setItem('mexcStop', JSON.stringify({ x: panel.style.left, y: panel.style.top }));
    });
  }

  function injectStyles() {
    if ($('#mexcStopStyles')) return;
    const s = document.createElement('style');
    s.id = 'mexcStopStyles';
    s.textContent = `
      #mexcStopPanel{position:fixed;z-index:2147483646;width:230px;background:#16181d;
        border:1px solid #2a2e37;border-radius:10px;color:#e6e6e6;font:13px/1.4 system-ui;
        box-shadow:0 10px 30px rgba(0,0,0,.5);user-select:none}
      #msHead{padding:8px 10px;font-weight:700;background:#1f2229;border-radius:10px 10px 0 0;
        display:flex;align-items:center;gap:7px}
      #msDot{width:9px;height:9px;border-radius:50%;background:#c4503a;display:inline-block}
      #msClose{margin-left:auto;cursor:pointer;opacity:.6}#msClose:hover{opacity:1}
      #msInfo{padding:8px 10px;font-size:12px;color:#cfd3da}
      #msInfo .long{color:#36c46a;font-weight:700}#msInfo .short{color:#ff6b6b;font-weight:700}
      .msBtns{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px 10px 8px}
      .msAct{background:#2563eb;border:0;color:#fff;border-radius:7px;padding:9px 6px;font-weight:700;cursor:pointer}
      .msAct:hover{filter:brightness(1.13)}
      .msAct.bu{grid-column:1/-1;background:#5b6470}
      #msResult{padding:8px 10px;border-top:1px solid #2a2e37;font-size:12px;color:#9fd3a7;word-break:break-all}
      #msCredit{padding:5px 10px 7px;border-top:1px solid #2a2e37;font-size:10px;color:#5c6472;text-align:center;letter-spacing:.03em}
      #msCredit b{color:#8b93a3;font-weight:700}`;
    document.head.appendChild(s);
  }

  /* =========================================================================
   *  ХОТКЕИ
   * ========================================================================= */
  if (CONFIG.HOTKEYS) {
    window.addEventListener('keydown', (e) => {
      if (!e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); applyStop('BU'); }
      else if (/^[1-9]$/.test(k)) {
        const lvl = CONFIG.PROFIT_LEVELS[parseInt(k, 10) - 1];
        if (lvl != null) { e.preventDefault(); applyStop('ROI', lvl); }
      }
    });
  }

  /* =========================================================================
   *  ОТЛАДКА:  MEXCStop.debug() / MEXCStop.raw()
   * ========================================================================= */
  window.MEXCStop = {
    debug() {
      console.group('%cMEXCStop', 'color:#2563eb;font-weight:700');
      console.log('Текущая позиция:', currentPosition());
      console.log('Все позиции:', [...positions.values()]);
      console.log('Сырых фреймов поймано:', rawFrames.length);
      console.groupEnd();
    },
    raw: () => rawFrames,
    positions,
    config: CONFIG,
    // Что скрипт считает кнопкой "Add":
    findAdd: () => { const b = findAddButton(); console.log('Add =', b); return b; },
    // Ручной тест открытия окна TP/SL:
    openTPSL: () => { const r = openTPSL(); console.log('openTPSL ->', r); return r; },
    // Тест поиска варнинг-кнопки (открой Risk reminder вручную и вызови):
    findWarning: () => { const b = findWarningConfirmButton(); console.log('warning confirm =', b); return b; },
    dismissWarning: () => dismissWarningPopups(5000),
  };

  /* запуск панели (только на фьючерсах), когда есть body */
  if (IS_FUTURES) {
    const boot = setInterval(() => { if (document.body) { clearInterval(boot); buildPanel(); } }, 300);
  }
})();
