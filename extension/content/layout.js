/* GRAVK Layout: content script (выполняется в MAIN world, как userscript с @grant none).
   Подключается на всех страницах gravk.com; сам проверяет, что открыта страница игры. */

/* =====================================================================
   ЧТО ДЕЛАЕТ СКРИПТ (на страницах /game/... и /en/game/...)
   1. Собирает общий контейнер .gravk-mid: блок оценок + панель кнопок справа.
   2. Переносит подпись "PC · 12 год · дата" внутрь рамки панели.
   3. Переносит три секции (Платформи, Колекція, Крамниці) под блок оценок.
   4. Пересобирает шапку оценок: [общая] [аватарки] [моя]; если своей оценки нет, ставит "--".
   5. Собирает левую колонку: описание + остальные теги под ним.
   6. Переносит строку версий игры (#tabs) в общий контейнер.
   7. Переносит заголовок "Статистика та відгуки" + отзывы в правую часть нижнего ряда.
   8. При переходе между страницами без перезагрузки перезагружает страницу
      (иначе перенесённые блоки ломают сайт).
   Оформление блоков делает стиль Stylus (классы gravk-*).
   ===================================================================== */

(function () {
  'use strict';

  /* ===================== НАСТРОЙКИ ===================== */

  // true: при переходе между страницами без перезагрузки страница перезагружается
  // (не чаще раза в 3 секунды). false: отключить.
  const RELOAD_ON_NAVIGATION = true;

  /* ===================== СЕЛЕКТОРЫ БЛОКОВ САЙТА ===================== */

  const POSTER_SEL = '.sm\\:max-w-\\[240px\\]';                                                     // постер игры
  const STATS_SEL  = 'div.xl\\:w-1\\/2.select-none';                                                // блок оценок
  const PANEL_SEL  = 'div.hidden.md\\:flex.flex-col.gap-2.items-start';                             // правая панель кнопок
  const DESC_SEL   = 'div.max-w-\\[600px\\]:has(> p.leading-relaxed)';                              // описание игры
  const TAGS_SEL   = 'div.flex.flex-col.gap-4:has(> div.flex-row.flex-wrap.md\\:flex-nowrap)';      // блок тегов
  const REV_SEL    = 'div.xl\\:w-1\\/2.min-w-0.flex.flex-col.gap-4';                                // колонка отзывов

  /* ===================== ЯЗЫК И ТИП СТРАНИЦЫ ===================== */

  const isEN       = () => /^\/en\//.test(location.pathname);          // английская версия сайта
  const isGamePage = () => /^\/(en\/)?game\//.test(location.pathname); // страница игры (uk или en)

  // Секции, которые переносятся под оценки (порядок = порядок на странице).
  // В каждой: украинское и английское название заголовка.
  const META_GROUPS = [
    ['Платформи', 'Platforms'],
    ['Колекція', 'Collection', 'Collections', 'Series'],
    ['Крамниці', 'Stores', 'Storefronts', 'Shops']
  ];

  // Заголовки секций, которые остаются под описанием (используются для защиты от захвата лишнего)
  const OTHER_HEADINGS = ['Жанри', 'Теми', 'Рушій', 'Genres', 'Genre', 'Themes', 'Theme', 'Engine', 'Engines'];

  /* ===================== НАВИГАЦИЯ БЕЗ ПЕРЕЗАГРУЗКИ ===================== */

  let touched = false;               // true, если на этой вкладке уже менялась раскладка
  let lastPath = location.pathname;

  // Срабатывает при смене адреса: перезагружает страницу, чтобы раскладка не ломалась
  function onRoute() {
    if (location.pathname === lastPath) return;
    if (RELOAD_ON_NAVIGATION && (touched || isGamePage())) {
      try {
        const last = +sessionStorage.getItem('gravk-reload') || 0;
        if (Date.now() - last < 3000) { lastPath = location.pathname; return; } // защита от цикла перезагрузок
        sessionStorage.setItem('gravk-reload', String(Date.now()));
      } catch (e) { /* sessionStorage недоступен: просто продолжаем */ }
      location.reload();
      return;
    }
    lastPath = location.pathname;
  }

  // Перехватываем смену адреса сайтом (pushState / replaceState) и кнопки "назад/вперёд"
  ['pushState', 'replaceState'].forEach(function (k) {
    const orig = history[k];
    history[k] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(onRoute, 0);
      return r;
    };
  });
  window.addEventListener('popstate', function () { setTimeout(onRoute, 0); });

  /* ===================== КЛАССЫ-МЕТКИ ===================== */
  // Сайт может сам стирать классы при перерисовке, поэтому метки запоминаются и восстанавливаются.

  const sticky = new Map();
  const addCls = (el, c) => { if (el && !el.classList.contains(c)) el.classList.add(c); };

  // Ставит класс и запоминает его
  function stick(el, c) {
    if (!el) return;
    addCls(el, c);
    let s = sticky.get(el);
    if (!s) { s = new Set(); sticky.set(el, s); }
    s.add(c);
  }

  // Возвращает запомненные классы, если сайт их стёр
  function restick() {
    sticky.forEach((s, el) => {
      if (!el.isConnected) { sticky.delete(el); return; }
      s.forEach(c => addCls(el, c));
    });
  }

  // Помечает обёртки между контейнером и элементом классом gravk-flat (стиль делает их display: contents),
  // чтобы перенесённый элемент вёл себя как прямой элемент контейнера
  function flatten(el, A, poster) {
    if (!el || !A.contains(el)) return;
    for (let n = el.parentElement; n && n !== A; n = n.parentElement) {
      if (n.contains(poster)) break;                                                                // обёртку постера не трогаем
      if (n.matches('.gravk-mid, .gravk-meta, .gravk-left, .gravk-reviews, .gravk-tabs')) break;    // свои контейнеры не трогаем
      stick(n, 'gravk-flat');
    }
  }

  /* ===================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ БЛОКА ОЦЕНОК ===================== */

  // Подставляет текст в первый текстовый узел элемента (остальные очищает)
  function setText(root, txt) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n, first = true;
    while ((n = w.nextNode())) {
      if (!n.nodeValue.trim()) continue;
      if (first) { n.nodeValue = txt; first = false; } else { n.nodeValue = ''; }
    }
  }

  // Прозрачный ли цвет
  function isTransparent(c) {
    return !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
  }

  // Ищет цвет фона элемента: сам элемент или ближайший родитель (до stopAt)
  function bgOf(el, stopAt) {
    for (let n = el; n && n !== stopAt; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (!isTransparent(c)) return c;
    }
    return null;
  }

  // Красит бейдж оценки (элемент уже должен быть в DOM):
  // цвет получают только скруглённые слои, остальные становятся прозрачными (иначе виден квадрат)
  function paint(root, color) {
    let painted = false;
    [root, ...root.querySelectorAll('*')].forEach(e => {
      const cs = getComputedStyle(e);
      const hasBg = !isTransparent(cs.backgroundColor) || cs.backgroundImage !== 'none';
      if (!hasBg) return;
      e.style.setProperty('background-image', 'none', 'important');
      e.style.setProperty('box-shadow', 'none', 'important');
      if (parseFloat(cs.borderTopLeftRadius) > 0) {
        e.style.setProperty('background-color', color, 'important');
        painted = true;
      } else {
        e.style.setProperty('background-color', 'transparent', 'important');
      }
    });
    if (!painted) { // запасной вариант: ни один слой не скруглён
      root.style.setProperty('background-color', color, 'important');
      root.style.setProperty('border-radius', '0.75rem', 'important');
    }
  }

  // Убирает служебные классы из копии элемента
  function cleanClone(el) {
    [el, ...el.querySelectorAll('*')].forEach(e => {
      ['gravk-hide', 'gravk-flat', 'gravk-avatars-block', 'gravk-stats-moved']
        .forEach(c => e.classList.remove(c));
    });
    return el;
  }

  // Ищет текстовый узел по шаблону внутри блока оценок (наши копии пропускает)
  function findText(stats, re) {
    const w = document.createTreeWalker(stats, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && n.parentElement.closest('.gravk-score'))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    let n;
    while ((n = w.nextNode())) { if (re.test(n.nodeValue)) return n; }
    return null;
  }

  // Находит элементы с числом (оценки), исключая бейджи аватарок и цифры кнопок статистики
  function numLeaves(stats) {
    return [...stats.querySelectorAll('*')].filter(e => {
      if (e.children.length || !/^\d{1,3}$/.test(e.textContent.trim())) return false;
      if (e.closest('.gravk-score')) return false;
      const g = e.closest('.flex.gap-3.flex-wrap, .grid');
      return !(g && g !== stats && stats.contains(g));
    });
  }

  // Склонение слова "оцінка" / "rating" для подписи под общей оценкой
  const plural = (n) => {
    if (isEN()) return n === 1 ? 'rating' : 'ratings';
    const k = n % 100, d = n % 10;
    if (k >= 11 && k <= 14) return 'оцінок';
    if (d === 1) return 'оцінка';
    if (d >= 2 && d <= 4) return 'оцінки';
    return 'оцінок';
  };

  /* ===================== ШАПКА ОЦЕНОК ===================== */
  // Собирает строку [общая оценка] [аватарки] [моя оценка].
  // "117 гравців оцінили гру" превращается в "117 оцінок", "Ваша оцінка" ставится под своей оценкой.
  // Если своей оценки нет, показывается серый бейдж с "--".

  function fixScore(stats) {
    const cntTn = findText(stats, /оцінил|rated/i);                      // текст "117 гравців оцінили гру" / "117 players rated"
    if (!cntTn) return;                                                  // данные ещё не загрузились
    const ownTn = findText(stats, /Ваш\S*\s+оцінк|Your\s+rating/i);      // текст "Ваша оцінка" / "Your rating"
    const avatars = stats.querySelector('.flex.gap-3.flex-wrap');
    if (!avatars) return;

    // Общая оценка: последнее число перед строкой "оцінили гру", берём внешнюю обёртку бейджа
    const leaves = numLeaves(stats);
    const before = leaves.filter(e => cntTn.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING);
    let totalEl = before[before.length - 1];
    if (!totalEl) return;
    while (totalEl.parentElement && totalEl.parentElement !== stats &&
           totalEl.parentElement.textContent.trim() === totalEl.textContent.trim()) {
      totalEl = totalEl.parentElement;
    }

    // Моя оценка: число после текста "Ваша оцінка" (если есть)
    let own = null;
    if (ownTn) {
      own = leaves.find(e => ownTn.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
    }

    // Подпись под общей оценкой: "117 оцінок" / "117 ratings"
    const pe = cntTn.parentElement;
    const src = (pe && !pe.contains(totalEl)) ? pe.textContent : cntTn.nodeValue;
    const nm = (src.match(/\d[\d\s.,]*/) || [])[0];
    const cnt = nm ? parseInt(nm.replace(/\D/g, ''), 10) : NaN;
    const totalLabel = isNaN(cnt)
      ? cntTn.nodeValue.replace(/\.?\s*(Ваш|Your).*$/i, '').trim()
      : cnt + ' ' + plural(cnt);

    // Если данные не изменились, ничего не перестраиваем
    const ownVal = own ? own.textContent.trim() : '';
    const ownBg = own ? bgOf(own, stats) : null;
    const sig = [totalEl.textContent.trim(), isNaN(cnt) ? '' : cnt, ownVal, ownBg || ''].join('|');
    let row = stats.querySelector('.gravk-scorerow');
    if (row && row.dataset.sig === sig) return;

    // Строка создаётся один раз: на месте блока аватарок (аватарки переезжают внутрь неё)
    if (!row) {
      let av = avatars;
      while (av.parentElement && av.parentElement !== stats &&
             !av.parentElement.querySelector('.grid.grid-cols-2') &&
             !av.parentElement.contains(totalEl) &&
             !av.parentElement.contains(cntTn)) {
        av = av.parentElement;
      }
      row = document.createElement('div');
      row.className = 'gravk-scorerow';
      av.parentElement.insertBefore(row, av);
      row.appendChild(av);
      stick(av, 'gravk-avatars-block');
    }
    row.querySelectorAll(':scope > .gravk-score').forEach(e => e.remove());   // убираем прошлые копии при обновлении данных

    // Одна оценка: бейдж + подпись под ним
    const mk = (badge, label, cls) => {
      const d = document.createElement('div');
      d.className = 'gravk-score ' + cls;
      d.appendChild(badge);
      const l = document.createElement('div');
      l.className = 'gravk-score-label';
      l.textContent = label;
      d.appendChild(l);
      return d;
    };

    const totalBadge = cleanClone(totalEl.cloneNode(true));   // копия общей оценки
    const mineBadge  = cleanClone(totalEl.cloneNode(true));   // та же форма и размер для моей оценки
    row.insertBefore(mk(totalBadge, totalLabel, 'gravk-score-total'), row.firstChild);
    row.appendChild(mk(mineBadge, isEN() ? 'Your rating' : 'Ваша оцінка', 'gravk-score-mine'));

    // Моя оценка: число (или "--") и цвет бейджа (красим, когда бейдж уже в DOM)
    setText(mineBadge, ownVal || '--');
    const leaf = [mineBadge, ...mineBadge.querySelectorAll('*')].find(e => !e.children.length);
    paint(mineBadge, (own && ownBg) ? ownBg : 'rgba(51, 65, 85, 0.55)');
    if (leaf) leaf.style.setProperty('color', own ? getComputedStyle(own).color : '#94a3b8', 'important');

    // Прячем оригиналы (они остаются в DOM, сайт продолжает их обновлять)
    stick(totalEl, 'gravk-hide');
    if (own) stick(own, 'gravk-hide');
    [cntTn, ownTn].forEach(tn => {
      if (!tn) return;
      const p = tn.parentElement;
      if (p && p !== stats && !p.contains(row) &&
          !p.querySelector('img, .grid, .flex.gap-3.flex-wrap')) {
        stick(p, 'gravk-hide');
      }
    });

    row.dataset.sig = sig;
  }

  /* ===================== ПЛАТФОРМИ / КОЛЕКЦІЯ / КРАМНИЦІ ПОД ОЦЕНКАМИ ===================== */
  // Находит три секции по заголовкам и переносит их под блок оценок в порядке META_GROUPS.

  // Есть ли внутри элемента заголовок другой секции (Жанри / Теми / Рушій...)
  const hasOtherHeading = (el) => [...el.querySelectorAll('*')].some(
    e => !e.children.length && OTHER_HEADINGS.includes(e.textContent.trim())
  );

  function moveMeta(A, mid) {
    const tagsBox = A.querySelector(TAGS_SEL);
    let meta = mid.querySelector(':scope > .gravk-meta');
    const scopes = [tagsBox, meta].filter(Boolean);
    if (!scopes.length) return;

    const found = META_GROUPS.map(names => {
      for (const sc of scopes) {
        // заголовок секции: элемент без детей с нужным текстом
        const h = [...sc.querySelectorAll('*')].find(
          e => !e.children.length && names.includes(e.textContent.trim())
        );
        if (!h) continue;
        // поднимаемся от заголовка до целой секции (заголовок + теги)
        let g = h;
        while (g.parentElement && g.parentElement !== sc && g.parentElement.children.length === 1) {
          g = g.parentElement;
        }
        const group = g.parentElement;
        // защита: не захватываем контейнер, в котором лежат и другие секции
        if (!group || group === sc || hasOtherHeading(group)) continue;
        return group;
      }
      return null;
    }).filter(Boolean);

    if (!found.length) return;
    if (!meta) {
      meta = document.createElement('div');
      meta.className = 'gravk-meta';
      mid.appendChild(meta);
    }
    // переносим только если порядок или состав изменился
    const cur = [...meta.children];
    const same = cur.length === found.length && cur.every((c, i) => c === found[i]);
    if (!same) found.forEach(g => meta.appendChild(g));
  }

  /* ===================== ОСНОВНАЯ РАСКЛАДКА ===================== */

  function run() {
    if (!isGamePage() || window.innerWidth < 768) return;   // только страницы игр и только на широком экране
    restick();                                              // вернуть метки, если сайт их стёр

    // Контейнер A: родитель постера (в нём строится вся раскладка)
    const poster = document.querySelector(POSTER_SEL);
    if (!poster) return;
    const A = poster.closest('div.flex.flex-col.md\\:flex-row');
    if (!A) return;
    touched = true;
    stick(A, 'gravk-root');
    stick([...A.children].find(c => c.contains(poster)), 'gravk-posterwrap');

    const panel = document.querySelector(PANEL_SEL);
    flatten(panel, A, poster);
    const stats = document.querySelector(STATS_SEL);

    // Шаг 1. Оценки и правая панель кладём в общий контейнер одной высоты
    if (stats) {
      let mid = A.querySelector(':scope > .gravk-mid');
      if (!mid) {
        mid = document.createElement('div');
        mid.className = 'gravk-mid';
        A.appendChild(mid);
      }
      if (stats.parentElement !== mid) mid.appendChild(stats);
      stick(stats, 'gravk-stats-moved');
      if (panel && panel.parentElement !== mid) mid.appendChild(panel);
    }

    // Шаг 2. Подпись "PC · 7 год · дата" переносим внутрь рамки панели
    if (panel) {
      const kids = [...panel.children];
      const frame = kids.find(c => c.tagName === 'DIV') || null;                      // рамка с кнопками
      const cap = panel.querySelector(':scope > p') ||                                // подпись снаружи рамки
                  (frame && frame.querySelector(':scope > .gravk-datecap')) || null;  // или уже перенесённая
      if (cap && frame && cap.parentElement !== frame) frame.appendChild(cap);
      if (cap) stick(cap, 'gravk-datecap');
    }

    // Шаг 3. Платформи / Колекція / Крамниці под оценки
    const midBox = A.querySelector(':scope > .gravk-mid');
    if (midBox) moveMeta(A, midBox);

    // Шаг 4. Шапка оценок: общая | аватарки | моя
    if (stats) fixScore(stats);

    // Шаг 5. Левая колонка: описание, под ним остальные теги (достаточно любого из двух блоков)
    const desc = A.querySelector(DESC_SEL);
    const tags = A.querySelector(TAGS_SEL);
    if (desc || tags) {
      let left = A.querySelector(':scope > .gravk-left');
      if (!left) {
        left = document.createElement('div');
        left.className = 'gravk-left';
        A.appendChild(left);
      }
      if (desc && desc.parentElement !== left) { flatten(desc, A, poster); left.insertBefore(desc, left.firstChild); }
      if (tags && tags.parentElement !== left) { flatten(tags, A, poster); left.appendChild(tags); }
    }

    // Шаг 6. Строка версий игры
    const tabs = document.getElementById('tabs');
    if (tabs) {
      if (tabs.parentElement !== A) A.appendChild(tabs);
      stick(tabs, 'gravk-tabs');
    }

    // Шаг 7. Заголовок секции ("Статистика та відгуки" / "Stats and reviews") + отзывы.
    // Заголовок определяется по положению (блок прямо перед отзывами), а не по тексту.
    if (!A.querySelector(':scope > .gravk-reviews')) {
      const col = [...document.querySelectorAll(REV_SEL)].find(e => !A.contains(e));
      if (col && col.parentElement) {
        const wrap = col.parentElement;
        const head = wrap.previousElementSibling;
        const rev = document.createElement('div');
        rev.className = 'gravk-reviews';
        A.appendChild(rev);
        if (head && !head.contains(wrap) && head.textContent.trim().length < 150) rev.appendChild(head);
        rev.appendChild(wrap);
      }
    }
  }

  // Любая ошибка не должна ломать страницу, только пишется в консоль
  function safeRun() {
    try { run(); } catch (e) { console.warn('[GRAVK layout]', e); }
  }

  /* ===================== ЗАПУСК ===================== */
  // Сайт рисуется на клиенте: следим за изменениями страницы и пересобираем раскладку
  // (с задержкой 200 мс, чтобы не запускать её на каждое мелкое изменение).

  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(safeRun, 200); };
  new MutationObserver(() => { onRoute(); schedule(); }).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class']
  });
  window.addEventListener('resize', schedule);

  safeRun();
})();
