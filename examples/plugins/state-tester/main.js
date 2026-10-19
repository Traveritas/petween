// Example third-party plugin (L1): a tray item that walks the main pet through the default brain's
// state keys, so you can see every state of a pet pack without a real agent.
// Install: copy this folder to <app data>/plugins/state-tester, then restart Petween.

const KEYS = ['active.thinking', 'active.edit', 'active.command.Bash', 'waiting', 'success', 'error', 'idle.long'];

export default {
  activate(ctx) {
    let i = -1;
    let lease = null;
    const item = ctx.tray.addItem({
      label: '状态测试：下一个',
      onClick() {
        const pet = ctx.pets.list()[0];
        if (!pet) return;
        lease?.release();
        i = (i + 1) % (KEYS.length + 1);
        if (i === KEYS.length) {
          lease = null;
          item.update({ label: '状态测试：下一个' });
          ctx.log.info('back to the brain output');
          return;
        }
        lease = pet.showState(KEYS[i], { priority: 45 });
        item.update({ label: `状态测试：${KEYS[i]}（点击继续）` });
        ctx.log.info(`showing ${KEYS[i]}`);
      },
    });
  },
};
