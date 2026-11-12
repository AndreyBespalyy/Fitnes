// Редактор скриншота для журнала замечаний: снимок открывается поверх страницы,
// на нём можно рисовать карандашом, обводить рамкой, ставить стрелки и писать текст. «Сохранить скриншот» — в запись.
import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';

type Pt = { x: number; y: number };
type Shape =
  | { t: 'pen'; color: string; pts: Pt[] }
  | { t: 'rect'; color: string; a: Pt; b: Pt }
  | { t: 'arrow'; color: string; a: Pt; b: Pt }
  | { t: 'text'; color: string; at: Pt; text: string };
type Tool = 'pen' | 'rect' | 'arrow' | 'text';

const TOOLS: [Tool, string, string][] = [['pen', '✎', 'Карандаш'], ['rect', '▭', 'Рамка'], ['arrow', '➚', 'Стрелка'], ['text', 'T', 'Текст']];
const COLORS: [string, string][] = [['#FF3B30', 'Красный'], ['#FF9500', 'Оранжевый'], ['#FFD60A', 'Жёлтый'], ['#34C759', 'Зелёный'], ['#0A84FF', 'Синий']];

function draw(ctx: CanvasRenderingContext2D, s: Shape, lw: number, fs: number) {
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (s.t === 'pen') {
    ctx.beginPath(); s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0].x + 0.1, s.pts[0].y);
    ctx.stroke();
  } else if (s.t === 'rect') {
    ctx.strokeRect(Math.min(s.a.x, s.b.x), Math.min(s.a.y, s.b.y), Math.abs(s.b.x - s.a.x), Math.abs(s.b.y - s.a.y));
  } else if (s.t === 'arrow') {
    const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x), h = lw * 4.5;
    ctx.beginPath(); ctx.moveTo(s.a.x, s.a.y); ctx.lineTo(s.b.x, s.b.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s.b.x, s.b.y);
    ctx.lineTo(s.b.x - h * Math.cos(ang - 0.45), s.b.y - h * Math.sin(ang - 0.45));
    ctx.lineTo(s.b.x - h * Math.cos(ang + 0.45), s.b.y - h * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  } else {
    // Текст с тёмной обводкой — читается на любом фоне
    ctx.font = `700 ${fs}px Onest, system-ui, sans-serif`; ctx.textBaseline = 'top';
    s.text.split('\n').forEach((line, i) => {
      const y = s.at.y + i * fs * 1.25;
      ctx.lineWidth = Math.max(3, fs / 6); ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(line, s.at.x, y);
      ctx.fillText(line, s.at.x, y);
    });
  }
}

export function ShotEditor({ src, onSave, onCancel }: { src: string; onSave: (dataUrl: string) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [cur, setCur] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState(COLORS[0][0]);
  const [typing, setTyping] = useState<{ at: Pt; screen: Pt; text: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { const i = new Image(); i.onload = () => setImg(i); i.src = src; }, [src]);
  const lw = img ? Math.max(3, Math.round(img.width / 320)) : 4;
  const fs = img ? Math.max(18, Math.round(img.width / 55)) : 22;

  useEffect(() => {
    const c = canvas.current; if (!c || !img) return;
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    for (const s of shapes) draw(ctx, s, lw, fs);
    if (cur) draw(ctx, cur, lw, fs);
  }, [img, shapes, cur]);

  // Фокус — в редактор, чтобы поля страницы под ним не ловили ввод
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus(); }, []);
  // Клавиши: Esc — закрыть, ⌘Z — отменить последнее. Дальше страницы не пускаем (у ресепшна свои горячие клавиши)
  const onKey = (e: RKeyboardEvent) => {
    e.stopPropagation();
    if (typing) return;
    if (e.key === 'Escape') onCancel();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); setShapes((s) => s.slice(0, -1)); }
  };

  const pos = (e: RPointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height };
  };
  const commitText = () => {
    if (typing?.text.trim()) setShapes((s) => [...s, { t: 'text', color, at: typing.at, text: typing.text.trim() }]);
    setTyping(null);
  };
  const down = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (typing) { commitText(); return; }
    const p = pos(e);
    if (tool === 'text') { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setTyping({ at: p, screen: { x: e.clientX - r.left, y: e.clientY - r.top }, text: '' }); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    setCur(tool === 'pen' ? { t: 'pen', color, pts: [p] } : { t: tool, color, a: p, b: p });
  };
  const move = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!cur) return;
    const p = pos(e);
    setCur(cur.t === 'pen' ? { ...cur, pts: [...cur.pts, p] } : cur.t === 'text' ? cur : { ...cur, b: p });
  };
  const up = () => {
    if (!cur) return;
    const tiny = (cur.t === 'rect' || cur.t === 'arrow') && Math.hypot(cur.b.x - cur.a.x, cur.b.y - cur.a.y) < lw * 2;
    if (!tiny) setShapes((s) => [...s, cur]);
    setCur(null);
  };
  const save = () => {
    const c = canvas.current; if (!c) return;
    // Большие снимки — в JPEG, чтобы запись быстро уходила
    onSave(c.width * c.height > 2_000_000 ? c.toDataURL('image/jpeg', 0.88) : c.toDataURL('image/png'));
  };
  const scale = (() => { const c = canvas.current; if (!c) return 1; const r = c.getBoundingClientRect(); return r.width / (c.width || 1); })();

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKey} className="shot-ed" role="dialog" aria-modal="true" aria-label="Скриншот: отметьте, что не так">
      <div className="shot-bar">
        <div className="shot-group" role="group" aria-label="Инструмент">
          {TOOLS.map(([k, ic, l]) => <button key={k} aria-pressed={tool === k} onClick={() => { commitText(); setTool(k); }} title={l}><span aria-hidden="true">{ic}</span><span className="shot-l">{l}</span></button>)}
        </div>
        <div className="shot-group" role="group" aria-label="Цвет">
          {COLORS.map(([c, l]) => <button key={c} className="shot-color" aria-pressed={color === c} aria-label={l} title={l} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
        <div className="shot-group">
          <button onClick={() => setShapes((s) => s.slice(0, -1))} disabled={!shapes.length} title="Отменить (⌘Z)">↶<span className="shot-l"> Отменить</span></button>
          <button onClick={() => setShapes([])} disabled={!shapes.length}>Очистить</button>
        </div>
        <div className="shot-sp" />
        <button className="btn" onClick={onCancel}>Отмена</button>
        <button className="btn pri" onClick={() => { commitText(); setTimeout(save, 60); }} disabled={!img}>Сохранить скриншот</button>
      </div>
      <div className="shot-hint small">{tool === 'text' ? 'Нажмите на место на скриншоте и напишите текст. Enter — готово, Shift+Enter — новая строка.' : tool === 'pen' ? 'Рисуйте, удерживая кнопку мыши или пальцем.' : 'Потяните мышью или пальцем от одного угла к другому.'}</div>
      <div className="shot-stage">
        <div className="shot-wrap">
          <canvas ref={canvas} className={`shot-canvas tool-${tool}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          {typing && <textarea ref={textRef} autoFocus className="shot-text" rows={1} value={typing.text} placeholder="Текст"
            style={{ left: typing.screen.x, top: typing.screen.y, color, fontSize: Math.max(13, fs * scale) }}
            onChange={(e) => setTyping({ ...typing, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); } if (e.key === 'Escape') { e.stopPropagation(); setTyping(null); } }} />}
        </div>
      </div>
    </div>
  );
}
