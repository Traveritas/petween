import { useState } from 'react';
import { call } from '../rpc';
import { Slider, Thumb, useAction, useLoad } from '../ui';

export function Pets() {
  const pets = useLoad(() => call('pets.list'));
  const packs = useLoad(() => call('packs.list'));
  const { busy, run } = useAction();
  const [addPack, setAddPack] = useState('');
  const packOf = (id: string) => packs.data?.find((p) => p.id === id);
  const refresh = () => {
    pets.reload();
    packs.reload();
  };

  return (
    <div className="page">
      <h1>宠物</h1>
      <p className="lead">桌面上的每一只宠物和它们穿的宠物包。可以同时养好几只。</p>

      <h2>正在桌面上</h2>
      <div className="card">
        {pets.data?.map((p) => (
          <div className="row" key={p.id}>
            <Thumb pack={packOf(p.pack)} />
            <div className="body">
              <div className="title">
                {p.packName}
                <span className="pill plain">{p.stateKey}</span>
              </div>
              <div className="sub">
                <span className="mono">{p.id}</span>
              </div>
            </div>
            <div className="controls">
              <select
                aria-label="宠物包"
                value={p.pack}
                disabled={busy}
                onChange={(e) => void run(() => call('pets.setPack', { id: p.id, pack: e.target.value }), '已换装').then(refresh)}
              >
                {packs.data?.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
              <Slider compact value={Math.round(p.scale * 100)} min={30} max={300} step={5} unit="%" onChange={(v) => void run(() => call('pets.setScale', { id: p.id, scale: v / 100 })).then(pets.reload)} />
              <button className="btn quiet small" disabled={busy || (pets.data?.length ?? 0) <= 1} onClick={() => void run(() => call('pets.remove', { id: p.id })).then(refresh)}>
                送走
              </button>
            </div>
          </div>
        ))}
        {pets.error && <div className="row err">{pets.error}</div>}
      </div>
      <div className="toolbar">
        <select aria-label="新宠物的宠物包" value={addPack} onChange={(e) => setAddPack(e.target.value)}>
          <option value="">选一个宠物包…</option>
          {packs.data?.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={!addPack || busy} onClick={() => void run(() => call('pets.add', { pack: addPack }), '新宠物出现在主屏中间').then(refresh)}>
          再养一只
        </button>
      </div>

      <h2>宠物包</h2>
      <div className="packs">
        {packs.data?.map((k) => (
          <div className="card pack" key={k.id}>
            <Thumb pack={k} size={74} />
            <div className="name">{k.name}</div>
            <div className="by">
              {k.builtin ? '内置' : k.creators.join('、') || '未署名'}
              {k.license && ` · ${k.license}`}
            </div>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <button className="btn" onClick={() => void run(() => call('packs.openFolder'))}>
          打开宠物包文件夹
        </button>
        <button className="btn quiet" onClick={refresh}>
          刷新
        </button>
        <span className="note">把宠物包文件夹（含 pet.json）放进去，再点刷新。</span>
      </div>
    </div>
  );
}
