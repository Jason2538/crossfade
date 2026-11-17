// 크로스페이드 · Luma · Aria 를 오가는 막대(dock)와 화면 넘기기입니다. Luma의 아래 탭바처럼
// 흐린 유리 알약 안에서 선택 표시가 스프링처럼 미끄러지고, 막대나 화면을 끌면 표시와 화면이 손을 그대로 따라옵니다.
// 위치는 0, 1, 2 같은 화면 번호이고, 끄는 동안에는 1.4 처럼 중간 값이 됩니다.

const SVG = 'http://www.w3.org/2000/svg';
// 스프링: 단단함과 감쇠. 살짝 튕기며 멈춥니다(Luma 탭 표시와 비슷한 느낌).
const STIFFNESS = 260;
const DAMPING = 28;
const START_PX = 8;
const FLICK_SPEED = 0.45; // px/ms
const RUBBER = 0.25;

function svgIcon(paths) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function createPager({ apps, current, layer, commit, delegate = () => null }) {
  const order = apps.map((app) => app.id);
  let position = order.indexOf(current());
  let animation = null;
  let dragging = false;
  let safety = 0;

  /* ---------- 막대 ---------- */
  const indicator = document.createElement('span');
  indicator.className = 'dock-ind';
  const buttons = apps.map((app, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.app = app.id;
    const label = document.createElement('span');
    label.textContent = app.label;
    button.append(svgIcon(app.icon), label);
    button.addEventListener('click', () => go(index));
    return button;
  });
  const dock = document.createElement('nav');
  dock.className = 'dock';
  dock.setAttribute('aria-label', '앱 전환');
  dock.append(indicator, ...buttons);

  // 선택 표시를 화면 번호 p 위치에 놓습니다. 버튼 사이에서는 위치와 너비를 섞습니다.
  function placeIndicator(p, { stretch = false } = {}) {
    if (!buttons[0].offsetWidth) return;
    const last = buttons.length - 1;
    const low = Math.max(0, Math.min(last, Math.floor(p)));
    const high = Math.min(last, low + 1);
    const t = Math.max(0, Math.min(1, p - low));
    const a = buttons[low];
    const b = buttons[high];
    const left = a.offsetLeft + (b.offsetLeft - a.offsetLeft) * t;
    const width = a.offsetWidth + (b.offsetWidth - a.offsetWidth) * t;
    // 바깥으로 더 끌면 고무줄처럼 조금만 나갑니다.
    const overflow = p < 0 ? p * a.offsetWidth * 0.5 : p > last ? (p - last) * b.offsetWidth * 0.5 : 0;
    indicator.style.width = `${width}px`;
    indicator.style.transform = `translateX(${left + overflow}px) scale(${stretch ? 1.06 : 1})`;
    const active = Math.max(0, Math.min(last, Math.round(p)));
    buttons.forEach((button, i) => {
      button.classList.toggle('on', i === active);
      button.setAttribute('aria-current', i === active ? 'page' : 'false');
    });
  }

  /* ---------- 화면 ---------- */
  // p 위치에 맞춰 화면들을 옆으로 놓습니다. 걸쳐 있는 두 화면만 보입니다.
  function placeScreens(p) {
    const width = innerWidth;
    order.forEach((name, i) => {
      const distance = i - p;
      const near = Math.abs(distance) < 1;
      const node = layer(name, near);
      if (!node) return;
      if (near) {
        node.hidden = false;
        node.style.transform = Math.abs(distance) > 0.0001 ? `translate3d(${distance * width}px, 0, 0)` : '';
      } else {
        node.style.transform = '';
        node.hidden = true;
      }
    });
  }

  function clearScreens() {
    for (const name of order) {
      const node = layer(name, false);
      if (node) node.style.transform = '';
    }
  }

  function render(p, options) {
    position = p;
    placeScreens(p);
    placeIndicator(p, options);
  }

  // 목표 번호까지 스프링으로 움직이고, 도착하면 그 화면으로 확정합니다. velocity 는 화면 번호/초.
  function animateTo(target, velocity = 0) {
    cancelAnimationFrame(animation);
    let p = position;
    let v = velocity;
    let last = performance.now();
    document.documentElement.classList.add('paging');
    const finish = () => {
      clearTimeout(safety);
      cancelAnimationFrame(animation);
      render(target);
      clearScreens();
      document.documentElement.classList.remove('paging');
      animation = null;
      if (order[target] !== current()) commit(order[target]);
    };
    // 화면이 버벅여 프레임이 드물게 와도 실제 지난 시간만큼 계산하므로 제시간에 도착합니다.
    const step = (now) => {
      let elapsed = Math.min(0.25, (now - last) / 1000);
      last = now;
      while (elapsed > 0) {
        const h = Math.min(1 / 240, elapsed);
        v += (-STIFFNESS * (p - target) - DAMPING * v) * h;
        p += v * h;
        elapsed -= h;
      }
      if (Math.abs(p - target) < 0.0015 && Math.abs(v) < 0.01) return finish();
      render(p);
      animation = requestAnimationFrame(step);
    };
    // 탭이 뒤로 가 프레임이 멈춰도 결국은 도착합니다.
    clearTimeout(safety);
    safety = setTimeout(finish, 1200);
    animation = requestAnimationFrame(step);
  }

  function go(index) {
    if (dragging) return;
    animateTo(Math.max(0, Math.min(order.length - 1, index)));
  }

  // 해시가 바뀌는 등 밖에서 화면이 정해졌을 때 맞춥니다.
  function sync() {
    if (animation || dragging) return;
    position = order.indexOf(current());
    placeIndicator(position);
  }

  /* ---------- 끌기 ---------- */
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

  const withRubber = (p) => {
    const max = order.length - 1;
    if (p < 0) return p * RUBBER;
    if (p > max) return max + (p - max) * RUBBER;
    return p;
  };

  // 손가락 위치를 화면 번호로 바꾸는 방법(toPosition)만 다르고, 따라가기·놓기는 같습니다.
  function track(down, { toPosition, edge = null }) {
    const root = document.documentElement;
    const start = { x: down.clientX, y: down.clientY, id: down.pointerId, p: position, samples: [[down.timeStamp, down.clientX]] };
    let mode = null; // 'page' | 'inner'
    let inner = null;

    const move = (event) => {
      if (event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start.samples.push([event.timeStamp, event.clientX]);
      if (start.samples.length > 6) start.samples.shift();
      if (!mode) {
        if (Math.abs(dy) > START_PX && Math.abs(dy) > Math.abs(dx)) return stop();
        if (Math.abs(dx) < START_PX) return;
        // 왼쪽 가장자리에서 오른쪽으로 끌면, 그 앱 안에서 뒤로 갈 곳이 있으면 그쪽이 먼저입니다.
        inner = edge === 'left' && dx > 0 ? delegate(current()) : null;
        mode = inner ? 'inner' : 'page';
        cancelAnimationFrame(animation);
        clearTimeout(safety);
        animation = null;
        dragging = mode === 'page';
        dock.classList.toggle('dragging', dragging);
        try {
          root.setPointerCapture(event.pointerId);
        } catch {
          // 잡지 못해도 대부분 그대로 동작합니다.
        }
      }
      event.preventDefault();
      if (mode === 'inner') return inner.move(dx);
      render(withRubber(toPosition(event.clientX, start)), { stretch: true });
    };

    const end = (event) => {
      if (event.pointerId !== start.id) return;
      stop();
      if (!mode) return;
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 60);
      const dx = event.clientX - start.x;
      const [t0, x0] = start.samples[0];
      const speed = (event.clientX - x0) / Math.max(1, event.timeStamp - t0); // px/ms
      if (mode === 'inner') return inner.end(dx, speed);
      dragging = false;
      dock.classList.remove('dragging');
      // 화면 번호로 바꾼 속도(번호/초). 막대와 화면은 손 방향이 반대라 toPosition 으로 환산합니다.
      const perPx = toPosition(event.clientX + 1, start) - toPosition(event.clientX, start);
      const velocity = speed * 1000 * perPx;
      let target = Math.round(position);
      if (Math.abs(speed) > FLICK_SPEED && event.type !== 'pointercancel') {
        target = velocity > 0 ? Math.ceil(position - 0.05) : Math.floor(position + 0.05);
        // 화면을 한 번 튕기면 한 칸만 넘어갑니다.
        target = Math.max(Math.round(start.p) - 1, Math.min(Math.round(start.p) + 1, target));
      }
      target = Math.max(0, Math.min(order.length - 1, target));
      animateTo(target, Math.max(-12, Math.min(12, velocity)));
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

  // 막대 위에서 끌면 선택 표시가 손가락 바로 아래로 오고, 화면도 그만큼 넘어갑니다(Luma 탭바와 같음).
  dock.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    const centers = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    const last = centers.length - 1;
    track(event, {
      toPosition(x) {
        if (x <= centers[0]) return (x - centers[0]) / (centers[1] - centers[0]);
        for (let i = 0; i < last; i += 1) if (x <= centers[i + 1]) return i + (x - centers[i]) / (centers[i + 1] - centers[i]);
        return last + (x - centers[last]) / (centers[last] - centers[last - 1]);
      },
    });
  });

  // 화면 위에서 끌면 손가락이 움직인 만큼 화면이 따라옵니다.
  function attachSwipe(node, { touchOnly = false, edge = null } = {}) {
    node.addEventListener('pointerdown', (event) => {
      if (event.button > 0 || (touchOnly && event.pointerType === 'mouse')) return;
      if (event.target.closest('input, select, textarea, dialog, .shelf, .no-swipe, .dock')) return;
      track(event, { toPosition: (x, start) => start.p - (x - start.x) / innerWidth, edge });
    });
  }

  addEventListener('resize', () => placeIndicator(position));
  requestAnimationFrame(() => placeIndicator(position));

  return { dock, attachSwipe, sync };
}
