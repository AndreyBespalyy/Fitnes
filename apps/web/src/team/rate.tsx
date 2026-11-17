// Оценка подсказки или ответа ИИ-помощника: «Полезно» / «Не то» с причиной. По этим оценкам помощник учится:
// полезное показывает чаще, лишнее — реже, удачные ответы берёт за образец (раздел «Чему научился помощник»).
import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import './rate.css';

const REASONS: [string, string][] = [['done_already', 'Уже сделал'], ['not_relevant', 'Неактуально'], ['wrong_data', 'Неверные данные'], ['unclear', 'Непонятно'], ['not_mine', 'Не моя задача'], ['other', 'Другое']];

/** url — адрес оценки (/api/agent/suggestions/:id/rate или /api/agent/notifications/:id/rate); value — уже поставленная оценка */
export function RateButtons({ url, value, compact = false, onRated }: { url: string; value?: number | null; compact?: boolean; onRated?: (v: 1 | -1) => void }) {
  const [v, setV] = useState<number | null>(value ?? null);
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const send = async (rating: 1 | -1, r?: string) => {
    setBusy(true); setErr('');
    try {
      const res = await api<{ message: string }>('POST', url, { rating, reason: rating === -1 ? r || null : null, comment: comment.trim() || null });
      setV(rating); setAsk(false); setNote(res.message); onRated?.(rating);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось, попробуйте ещё раз'); }
    finally { setBusy(false); }
  };
  if (v != null && !ask) {
    return (
      <div className={`ai-rate done${compact ? ' compact' : ''}`} onClick={(e) => e.stopPropagation()}>
        <span>{v === 1 ? '👍 Полезно' : '👎 Не то'}{note ? ` — ${note}` : ''}</span>
        <button type="button" className="ai-rate-link" onClick={() => { setV(null); setNote(''); }}>изменить</button>
      </div>
    );
  }
  return (
    <div className={`ai-rate${compact ? ' compact' : ''}`} onClick={(e) => e.stopPropagation()}>
      {!ask && <>
        <button type="button" className="ai-rate-btn" disabled={busy} onClick={() => void send(1)} title="Подсказка помогла — буду давать такие чаще">👍 Полезно</button>
        <button type="button" className="ai-rate-btn" disabled={busy} onClick={() => setAsk(true)} title="Не помогло — выберите причину, помощник учтёт">👎 Не то</button>
      </>}
      {ask && (
        <div className="ai-rate-ask">
          <div className="ai-rate-q">Почему не то?</div>
          <div className="ai-rate-reasons">
            {REASONS.map(([k, label]) => <button key={k} type="button" className={`ai-rate-chip${reason === k ? ' on' : ''}`} disabled={busy} onClick={() => setReason(k)}>{label}</button>)}
          </div>
          <input className="ai-rate-comment" placeholder="Комментарий (необязательно): что было бы полезнее?" maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="ai-rate-row">
            <button type="button" className="ai-rate-send" disabled={busy || !reason} onClick={() => void send(-1, reason)}>Отправить</button>
            <button type="button" className="ai-rate-link" onClick={() => setAsk(false)}>Отмена</button>
          </div>
        </div>
      )}
      {err && <small className="ai-rate-err">{err}</small>}
    </div>
  );
}
