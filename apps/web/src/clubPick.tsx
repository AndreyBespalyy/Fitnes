// Выбор клуба прямо на странице (проверка CRM 17.11.2026, п. 8): когда вверху выбрано «Все клубы», раздел,
// которому нужен один клуб, не просит «выберите вверху», а сам показывает первый клуб и кнопки других клубов.
import { useState, type ReactNode } from 'react';
import type { Club } from './api.ts';

export function useClubPick(clubs: Club[], clubId: string): [Club | null, ReactNode] {
  const [picked, setPicked] = useState('');
  if (clubId !== 'all') return [clubs.find((c) => c.id === clubId) ?? null, null];
  const club = clubs.find((c) => c.id === picked) ?? clubs[0] ?? null;
  const chips = clubs.length > 1
    ? <div className="tabs" role="group" aria-label="Клуб">{clubs.map((c) => <button key={c.id} aria-pressed={club?.id === c.id} onClick={() => setPicked(c.id)}>{c.name}</button>)}</div>
    : null;
  return [club, chips];
}
