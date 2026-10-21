// Example third-party plugin (L1): walks the main pet through the default brain's state keys, so you
// can see every state of a pet pack without a real agent. Two ways to drive it:
//   - the tray item "状态测试：下一个" steps through the keys;
//   - its own settings page (settings.js) shows one button per key.
// Install: copy this folder to <app data>/plugins/state-tester, then restart Petween.

const KEYS = ['active.thinking', 'active.edit', 'active.command.Bash', 'waiting', 'success', 'error', 'idle.long'];

export default {
  activate(ctx) {
    let i = -1;
    let lease = null;
    let release = null;

    const show = (key) => {
      const pet = ctx.pets.list()[0];
      if (!pet) return false;
      lease?.release();
      release?.dispose();
      release = null;
      lease = key ? pet.showState(key, { priority: 45 }) : null;
      item.update({ label: key ? `状态测试：${key}（点击继续）` : '状态测试：下一个' });
      ctx.log.info(key ? `showing ${key}` : 'back to the brain output');
      // Written by the settings page: hand the pet back after N seconds (0 = keep).
      const holdSec = Number(ctx.settings.get('holdSec', 0));
      if (key && holdSec > 0) release = ctx.setTimeout(() => show(null), holdSec * 1000);
      return true;
    };

    const item = ctx.tray.addItem({
      label: '状态测试：下一个',
      onClick() {
        i = (i + 1) % (KEYS.length + 1);
        show(i === KEYS.length ? null : KEYS[i]);
      },
    });

    // Requests from settings.js.
    ctx.settingsPage.handle('keys', () => ({ keys: KEYS }));
    ctx.settingsPage.handle('show', (key) => {
      if (!show(typeof key === 'string' ? key : null)) throw new Error('没有宠物');
    });
  },
};
