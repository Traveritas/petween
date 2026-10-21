// The plugin's own settings page (docs/06 §8). It runs in the settings window, inside a shadow root;
// the window's classes (btn, input, field…) and colour tokens (--accent…) can be used here.

export async function mount(el, api) {
  const values = await api.settings.all();
  const { keys } = await api.call('keys');

  el.innerHTML = `
    <style>
      .keys { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
      .keys .btn.on { border-color: var(--accent); color: var(--accent); }
    </style>
    <div class="note">点一个状态，主宠物立刻切过去；「交还」回到 agent 的状态。</div>
    <div class="keys"></div>
    <div class="field">
      <div class="label">
        <div>自动交还</div>
        <div class="sub">切过去之后多少秒交还给 agent；0 = 一直保持</div>
      </div>
      <input class="input num" type="number" min="0" max="60" step="1">
    </div>
  `;

  const row = el.querySelector('.keys');
  const buttons = [];
  const pick = async (key) => {
    try {
      await api.call('show', key);
      for (const b of buttons) b.classList.toggle('on', b.dataset.key === key);
    } catch (e) {
      api.toast(e.message, true);
    }
  };
  for (const key of keys) {
    const b = document.createElement('button');
    b.className = 'btn small mono';
    b.textContent = key;
    b.dataset.key = key;
    b.onclick = () => pick(key);
    buttons.push(b);
    row.append(b);
  }
  const back = document.createElement('button');
  back.className = 'btn small primary';
  back.textContent = '交还';
  back.onclick = () => pick(null);
  row.append(back);

  const hold = el.querySelector('input');
  hold.value = String(values.holdSec ?? 0);
  hold.onchange = async () => {
    const n = Math.max(0, Math.min(60, Math.round(Number(hold.value) || 0)));
    hold.value = String(n);
    await api.settings.set('holdSec', n);
    api.toast('已保存');
  };
}
