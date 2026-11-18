// Ссылка «Изменить в настройках клуба» (повторная проверка CRM 18.11.2026, п. 4): настройки клуба правятся в одном месте —
// «Настройки клуба», с историей изменений; деньги и правила для клиентов — через черновик и утверждение.
export function ToConfig({ view, text }: { view: 'rules' | 'sales'; text: string }) {
  return (
    <div className="item row between" style={{ gap: 8, flexWrap: 'wrap' }}>
      <span className="small">{text}</span>
      <button className="btn sm" onClick={() => window.dispatchEvent(new CustomEvent('crm-go', { detail: `/?tab=config&view=${view}` }))}>Изменить в настройках клуба</button>
    </div>
  );
}
