// 크로스페이드 · Luma · Aria 를 손가락이나 마우스로 끌어 넘기는 장치입니다.
// 끄는 동안 지금 화면과 옆 화면이 손을 따라 움직이고, 놓으면 Apple처럼 감속하며 자리를 잡습니다.

// iOS 화면 전환과 비슷한 감속 곡선입니다.
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SLIDE_MS = 480;
const SNAP_MS = 380;
// 이만큼 끌거나(화면 너비 대비) 이만큼 빠르게(px/ms) 밀면 넘깁니다.
const COMMIT_RATIO = 0.28;
const COMMIT_SPEED = 0.45;
const START_PX = 8;

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

export function createSwitcher({ order, current, layer, commit, delegate = () => null }) {
  let busy = false;

  const neighbour = (name, step) => order[order.indexOf(name) + step] ?? null;

  // 위쪽 메뉴의 흰 알약(선택 표시)을 index 위치로 옮깁니다. index 는 1.4 처럼 중간 값일 수 있습니다.
  function placeThumbs(index, animate = true) {
    for (const nav of document.querySelectorAll('.app-switch')) {
      const tabs = [...nav.querySelectorAll('a')];
      const thumb = nav.querySelector('.switch-thumb');
      if (!thumb || !tabs.length) continue;
      const low = Math.max(0, Math.min(tabs.length - 1, Math.floor(index)));
      const high = Math.min(tabs.length - 1, low + 1);
      const t = Math.max(0, Math.min(1, index - low));
      const left = tabs[low].offsetLeft + (tabs[high].offsetLeft - tabs[low].offsetLeft) * t;
      const width = tabs[low].offsetWidth + (tabs[high].offsetWidth - tabs[low].offsetWidth) * t;
      thumb.style.transition = animate ? `transform ${SLIDE_MS}ms ${EASE_OUT}, width ${SLIDE_MS}ms ${EASE_OUT}` : 'none';
      thumb.style.width = `${width}px`;
      thumb.style.transform = `translateX(${left}px)`;
      const active = Math.round(index);
      tabs.forEach((tab, i) => tab.classList.toggle('on', i === active));
    }
  }

  function setX(node, x, ms = 0, easing = EASE_OUT) {
    node.style.transition = ms ? `transform ${ms}ms ${easing}` : 'none';
    node.style.transform = x ? `translate3d(${x}px, 0, 0)` : '';
  }

  function clear(...nodes) {
    for (const node of nodes) {
      node.style.transition = '';
      node.style.transform = '';
      node.style.willChange = '';
    }
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms + 40));

  // from 화면에서 to 화면으로 넘깁니다. dx 는 이미 끈 거리입니다.
  async function slide(to, { dx = 0, speed = 0 } = {}) {
    const from = current();
    if (busy || !to || to === from) return;
    busy = true;
    const dir = order.indexOf(to) > order.indexOf(from) ? 1 : -1;
    const width = innerWidth;
    const a = layer(from);
    const b = layer(to, true);
    a.style.willChange = b.style.willChange = 'transform';
    setX(a, dx);
    setX(b, dx + dir * width);
    await nextFrame();
    // 빠르게 밀었으면 그만큼 짧게 끝냅니다.
    const remaining = 1 - Math.min(1, Math.abs(dx) / width);
    const ms = Math.max(220, Math.min(SLIDE_MS, (remaining * width) / Math.max(Math.abs(speed), 0.0001), SLIDE_MS * remaining + 180));
    setX(a, -dir * width, ms);
    setX(b, 0, ms);
    placeThumbs(order.indexOf(to));
    await wait(ms);
    clear(a, b);
    busy = false;
    commit(to);
  }

  async function snapBack(dx, neighbourName) {
    const from = current();
    const a = layer(from);
    const b = neighbourName ? layer(neighbourName) : null;
    const dir = dx < 0 ? 1 : -1;
    setX(a, 0, SNAP_MS);
    if (b) setX(b, dir * innerWidth, SNAP_MS);
    placeThumbs(order.indexOf(from));
    await wait(SNAP_MS);
    clear(a);
    if (b) {
      clear(b);
      b.hidden = true;
    }
  }

  // node 위에서 가로로 끌면 화면을 넘깁니다. edge 가 'left' 면 그 화면 안쪽으로 먼저 물어봅니다.
  // 끄는 도중 화면이 다시 그려져 node 가 바뀌어도 놓치지 않도록, 움직임과 손 떼기는 문서 전체에서 받습니다.
  let suppressClick = false;
  window.addEventListener(
    'click',
    (event) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  function attach(node, { touchOnly = false, mouseOnly = false, edge = null } = {}) {
    node.addEventListener('pointerdown', (event) => {
      if (busy || event.button > 0 || (touchOnly && event.pointerType === 'mouse') || (mouseOnly && event.pointerType !== 'mouse')) return;
      if (event.target.closest('input, select, textarea, dialog, .shelf, .no-swipe')) return;
      track(event, edge);
    });
  }

  function track(down, edge) {
    const start = { x: down.clientX, y: down.clientY, id: down.pointerId, samples: [[down.timeStamp, down.clientX]] };
    let drag = null;
    const root = document.documentElement;

    const move = (event) => {
      if (event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start.samples.push([event.timeStamp, event.clientX]);
      if (start.samples.length > 6) start.samples.shift();
      if (!drag) {
        if (Math.abs(dy) > START_PX && Math.abs(dy) > Math.abs(dx)) return stop();
        if (Math.abs(dx) < START_PX) return;
        // 왼쪽 가장자리에서 오른쪽으로 끌 때, 그 화면이 뒤로 갈 수 있으면 화면 안에서 처리합니다.
        const inner = edge === 'left' && dx > 0 ? delegate(current()) : null;
        drag = { inner, from: current(), neighbour: inner ? null : neighbour(current(), dx < 0 ? 1 : -1) };
        if (!inner && drag.neighbour) layer(drag.neighbour, true);
        // 마우스가 Luma·Aria 화면(다른 문서) 위로 지나가도 계속 받도록 문서 전체가 잡습니다.
        try {
          root.setPointerCapture(event.pointerId);
        } catch {
          // 잡지 못해도 대부분 그대로 동작합니다.
        }
      }
      event.preventDefault();
      if (drag.inner) return drag.inner.move(dx);
      // 넘길 화면이 없으면 고무줄처럼 덜 움직입니다.
      const x = drag.neighbour ? dx : dx * 0.25;
      setX(layer(drag.from), x);
      if (drag.neighbour) {
        const dir = order.indexOf(drag.neighbour) > order.indexOf(drag.from) ? 1 : -1;
        setX(layer(drag.neighbour), x + dir * innerWidth);
        placeThumbs(order.indexOf(drag.from) + -x / innerWidth, false);
      }
    };

    const end = (event) => {
      if (event.pointerId !== start.id) return;
      stop();
      if (!drag) return;
      const dx = event.clientX - start.x;
      const [t0, x0] = start.samples[0];
      const speed = (event.clientX - x0) / Math.max(1, event.timeStamp - t0);
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 60);
      if (drag.inner) return drag.inner.end(dx, speed);
      const forward = Math.abs(dx) > innerWidth * COMMIT_RATIO || (Math.abs(speed) > COMMIT_SPEED && Math.sign(speed) === Math.sign(dx));
      if (drag.neighbour && forward && event.type !== 'pointercancel') slide(drag.neighbour, { dx, speed });
      else snapBack(dx, drag.neighbour);
    };

    function stop() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      try {
        root.releasePointerCapture(start.id);
      } catch {
        // 이미 풀렸으면 무시합니다.
      }
    }

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  return { slide, attach, placeThumbs };
}
