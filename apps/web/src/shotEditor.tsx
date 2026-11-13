// Редактор скриншота для журнала замечаний: снимок открывается во всплывающем окне поверх страницы.
// Главное — «Выделить область»: обвести место на снимке и кнопкой «Вставить текст» подписать именно эту область
// (подпись привязана к рамке и пронумерована). Дополнительно: стрелка и карандаш, цвета, «Отменить».
import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';

type Pt = { x: number; y: number };
type Area = { t: 'area'; color: string; a: Pt; b: Pt; note: string };
type Shape = Area | { t: 'pen'; color: string; pts: Pt[] } | { t: 'arrow'; color: string; a: Pt; b: Pt };
type Tool = 'area' | 'arrow' | 'pen';

const TOOLS: [Tool, string, string][] = [['area', '▭', 'Выделить область'], ['arrow', '➚', 'Стрелка'], ['pen', '✎', 'Карандаш']];
const COLORS: [string, string][] = [['#FF3B30', 'Красный'], ['#FF9500', 'Оранжевый'], ['#FFD60A', 'Жёлтый'], ['#34C759', 'Зелёный'], ['#0A84FF', 'Синий']];
const box = (s: { a: Pt; b: Pt }) => ({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.b.x - s.a.x), h: Math.abs(s.b.y - s.a.y) });

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/** Рисует фигуры; у выделенной области — номер и подпись рядом с ней */
function draw(ctx: CanvasRenderingContext2D, W: number, H: number, s: Shape, n: number, lw: number, fs: number, selected: boolean) {
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
  if (s.t === 'pen') {
    ctx.beginPath(); s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0].x + 0.1, s.pts[0].y);
    ctx.stroke(); return;
  }
  if (s.t === 'arrow') {
    const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x), h = lw * 4.5;
    ctx.beginPath(); ctx.moveTo(s.a.x, s.a.y); ctx.lineTo(s.b.x, s.b.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.b.x, s.b.y);
    ctx.lineTo(s.b.x - h * Math.cos(ang - 0.45), s.b.y - h * Math.sin(ang - 0.45));
    ctx.lineTo(s.b.x - h * Math.cos(ang + 0.45), s.b.y - h * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill(); return;
  }
  const r = box(s);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  if (selected) { ctx.save(); ctx.setLineDash([lw * 2, lw * 2]); ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1, lw / 2); ctx.strokeRect(r.x - lw, r.y - lw, r.w + lw * 2, r.h + lw * 2); ctx.restore(); }
  // Номер области в кружке
  const rad = fs * 0.75;
  const cx = Math.max(rad, r.x), cy = Math.max(rad, r.y);
  ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fillStyle = s.color; ctx.fill();
  ctx.fillStyle = '#000'; ctx.font = `800 ${fs}px Onest, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(n), cx, cy + 1); ctx.textAlign = 'left';
  if (!s.note.trim()) return;
  // Подпись: плашка под областью (или над ней, если внизу нет места)
  ctx.font = `600 ${fs}px Onest, system-ui, sans-serif`; ctx.textBaseline = 'top';
  const pad = fs * 0.45, lh = fs * 1.3;
  const maxW = Math.max(fs * 10, Math.min(W * 0.45, Math.max(r.w, fs * 16)));
  const lines = wrap(ctx, `${n}. ${s.note.trim()}`, maxW);
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2, th = lines.length * lh + pad * 2;
  let x = Math.min(Math.max(0, r.x), W - tw), y = r.y + r.h + lw * 2;
  if (y + th > H) y = Math.max(0, r.y - th - lw * 2);
  ctx.fillStyle = 'rgba(10,14,19,.92)'; ctx.fillRect(x, y, tw, th);
  ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(2, lw / 1.5); ctx.strokeRect(x, y, tw, th);
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * lh));
}

export function ShotEditor({ src, onSave, onCancel }: { src: string; onSave: (dataUrl: string, areaNotes: string[]) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [cur, setCur] = useState<Shape | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>('area');
  const [color, setColor] = useState(COLORS[0][0]);
  const [typing, setTyping] = useState<{ idx: number; text: string } | null>(null);
  const [, redraw] = useState(0);

  useEffect(() => { const i = new Image(); i.onload = () => setImg(i); i.src = src; }, [src]);
  useEffect(() => { root.current?.focus(); const r = () => redraw((x) => x + 1); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, []);
  const lw = img ? Math.max(3, Math.round(img.width / 360)) : 4;
  const fs = img ? Math.max(16, Math.round(img.width / 70)) : 18;
  const areaNo = (idx: number) => shapes.slice(0, idx + 1).filter((s) => s.t === 'area').length;

  useEffect(() => {
    const c = canvas.current; if (!c || !img) return;
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    shapes.forEach((s, i) => draw(ctx, c.width, c.height, typing?.idx === i && s.t === 'area' ? { ...s, note: '' } : s, areaNo(i), lw, fs, sel === i));
    if (cur) draw(ctx, c.width, c.height, cur, areaNo(shapes.length - 1) + 1, lw, fs, false);
  }, [img, shapes, cur, sel, typing?.idx]);

  const pos = (e: { clientX: number; clientY: number }): Pt => {
    const c = canvas.current!; const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const hit = (p: Pt) => { for (let i = shapes.length - 1; i >= 0; i--) { const s = shapes[i]; if (s.t !== 'area') continue; const r = box(s); if (p.x >= r.x - lw * 2 && p.x <= r.x + r.w + lw * 2 && p.y >= r.y - lw * 2 && p.y <= r.y + r.h + lw * 2) return i; } return null; };

  const commitText = () => {
    if (!typing) return;
    setShapes((all) => all.map((s, i) => (i === typing.idx && s.t === 'area' ? { ...s, note: typing.text } : s)));
    setTyping(null);
  };
  const startText = (idx: number | null = sel) => {
    if (idx == null) return;
    const s = shapes[idx]; if (s?.t !== 'area') return;
    setTyping({ idx, text: s.note });
  };

  const down = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (typing) commitText();
    const p = pos(e);
    if (tool === 'area') {
      const h = hit(p);
      if (h != null && box(shapes[h] as Area).w > 0) { setSel(h); return; } // нажали на готовую область — выбираем её
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setSel(null);
    setCur(tool === 'pen' ? { t: 'pen', color, pts: [p] } : tool === 'arrow' ? { t: 'arrow', color, a: p, b: p } : { t: 'area', color, a: p, b: p, note: '' });
  };
  const move = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!cur) return;
    const p = pos(e);
    setCur(cur.t === 'pen' ? { ...cur, pts: [...cur.pts, p] } : { ...cur, b: p });
  };
  const up = () => {
    if (!cur) return;
    const tiny = cur.t !== 'pen' && Math.hypot(cur.b.x - cur.a.x, cur.b.y - cur.a.y) < lw * 3;
    if (!tiny) {
      const idx = shapes.length;
      setShapes((s) => [...s, cur]);
      if (cur.t === 'area') setSel(idx); // новая область сразу выбрана: можно нажать «Вставить текст»
    }
    setCur(null);
  };
  const undo = () => { setTyping(null); setSel(null); setShapes((s) => s.slice(0, -1)); };
  const removeSel = () => { if (sel == null) return; setTyping(null); setShapes((s) => s.filter((_, i) => i !== sel)); setSel(null); };
  const save = () => {
    const c = canvas.current; if (!c || !img) return;
    // Перерисовываем без пунктира выбора и с введённым текстом
    const all = typing ? shapes.map((s, i) => (i === typing.idx && s.t === 'area' ? { ...s, note: typing.text } : s)) : shapes;
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
    all.forEach((s, i) => draw(ctx, c.width, c.height, s, all.slice(0, i + 1).filter((x) => x.t === 'area').length, lw, fs, false));
    const notes = all.filter((x): x is Area => x.t === 'area').map((x) => x.note.trim()).filter(Boolean);
    onSave(c.width * c.height > 2_000_000 ? c.toDataURL('image/jpeg', 0.88) : c.toDataURL('image/png'), notes);
  };
  const onKey = (e: RKeyboardEvent) => {
    e.stopPropagation(); // у страниц под окном свои горячие клавиши (ресепшн)
    if (typing) return;
    if (e.key === 'Escape') onCancel();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if ((e.key === 'Backspace' || e.key === 'Delete') && sel != null) { e.preventDefault(); removeSel(); }
    if (e.key === 'Enter' && sel != null) { e.preventDefault(); startText(); }
  };

  // Поле подписи ставим прямо под выбранной областью на экране
  const field = (() => {
    if (!typing || !canvas.current) return null;
    const s = shapes[typing.idx]; if (s?.t !== 'area') return null;
    const c = canvas.current, k = c.getBoundingClientRect().width / (c.width || 1), r = box(s);
    return { left: Math.max(0, r.x * k), top: (r.y + r.h) * k + 6, width: Math.max(220, Math.min(420, r.w * k)), color: s.color };
  })();
  const selArea = sel != null && shapes[sel]?.t === 'area';

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKey} className="shot-ed" role="dialog" aria-modal="true" aria-label="Скриншот: выделите, что не так">
      <div className="shot-bar">
        <div className="shot-group" role="group" aria-label="Инструмент">
          {TOOLS.map(([k, ic, l]) => <button key={k} aria-pressed={tool === k} onClick={() => { commitText(); setTool(k); }} title={l}><span aria-hidden="true">{ic}</span><span className="shot-l">{l}</span></button>)}
        </div>
        <button className="btn shot-text-btn" disabled={!selArea} onClick={() => startText()} title={selArea ? 'Подписать выделенную область' : 'Сначала выделите область'}>T Вставить текст</button>
        <div className="shot-group" role="group" aria-label="Цвет">
          {COLORS.map(([c, l]) => <button key={c} className="shot-color" aria-pressed={color === c} aria-label={l} title={l} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
        <div className="shot-group">
          <button onClick={undo} disabled={!shapes.length} title="Отменить (⌘Z)">↶<span className="shot-l"> Отменить</span></button>
          {selArea && <button onClick={removeSel} title="Удалить выделенную область (⌫)">Удалить</button>}
        </div>
        <div className="shot-sp" />
        <button className="btn" onClick={onCancel}>Отмена</button>
        <button className="btn pri" onClick={save} disabled={!img}>Сохранить скриншот</button>
      </div>
      <div className="shot-hint small">
        {typing ? 'Напишите, что не так в этой области. Enter — готово, Shift+Enter — новая строка.'
          : tool === 'area' ? (selArea ? 'Область выделена: нажмите «Вставить текст», чтобы подписать её. Нажатие на другую область выбирает её.' : 'Обведите мышью или пальцем место на снимке, затем нажмите «Вставить текст».')
          : tool === 'arrow' ? 'Потяните от начала стрелки к её острию.' : 'Рисуйте, удерживая кнопку мыши или пальцем.'}
      </div>
      <div className="shot-stage">
        <div className="shot-wrap">
          <canvas ref={canvas} className={`shot-canvas tool-${tool}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          {typing && field && <textarea autoFocus className="shot-text" rows={2} value={typing.text} placeholder={`Что не так в области ${areaNo(typing.idx)}?`}
            style={{ left: field.left, top: field.top, width: field.width, borderColor: field.color }}
            onChange={(e) => setTyping({ ...typing, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); } if (e.key === 'Escape') { e.stopPropagation(); setTyping(null); } }} />}
        </div>
      </div>
    </div>
  );
}
