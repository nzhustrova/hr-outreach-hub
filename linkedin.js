// Канонический ключ личности LinkedIn — slug (ТЗ этап L, задача L1.1).
//
// Зачем один модуль: до него в системе жили ТРИ формата одного и того же человека —
// `identityKeyServer` даёт «linkedin.com/in/patrickservino», GetSales оперирует голым
// «patrickservino», Kommo хранит полный URL четырёх форм (http/https × www/без). Три
// независимые нормализации неизбежно разъезжаются (прецедент: порог давности барьера
// считался двумя способами и расходился на границе — журнал ТЗ 13.08).
//
// Ключом выбран slug: схема, www, регистр и хвостовой слэш к личности отношения не имеют,
// а slug — ровно то, чем оперирует GetSales (`lead.linkedin`).

/**
 * URL или «голая» строка → slug. Мусор и пустота → null.
 *   'http://www.linkedin.com/in/PatrickServino/' → 'patrickservino'
 *   'patrickservino'                             → 'patrickservino'
 *   'https://linkedin.com/in/x?trk=…'            → 'x'
 */
export function linkedinSlug(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/linkedin\.com\/in\/([^/?#]+)/i);
  let slug = m ? m[1] : null;
  if (!slug) {
    // Голый slug (так отдаёт GetSales) — В ТОМ ЧИСЛЕ с юникодом: «terje-strømmen-788b04»,
    // «eric-silver-银-9087631», «aditya-…-cissp®» (78 живых примеров в выгрузке L0.10,
    // латинский фильтр их терял). Не принимаем только то, что slug'ом быть не может:
    // пробелы (имя), «@» (почта), слэш (путь), точку (домен — в public identifier её нет).
    // Слово «linkedin» внутри slug'а законно: живой пример — «jayzhaolinkedin» (Jay Zhao).
    if (!/[\s@/.]/.test(s)) slug = s;
    else return null;
  }
  try { slug = decodeURIComponent(slug); } catch { /* битый percent-encoding — оставляем как есть */ }
  slug = slug.replace(/\/+$/, '').trim().toLowerCase();
  return slug || null;
}

// Формы URL, в которых LinkedIn-профиль встречается в Kommo (замер 13.08 по 7 001 записи):
// http://www. — 94%, https://www. — 5%, остальное — единицы. Нужны для поиска карточки
// через `query=`: Kommo матчит поле «Linkedin profile» только ПОЛНЫМ URL с точной схемой
// (хвостовой слэш не важен) — проверено живыми вызовами (сводка GetSales §9.4).
export function linkedinUrlVariants(slug) {
  const s = linkedinSlug(slug);
  if (!s) return [];
  return [
    `http://www.linkedin.com/in/${s}`,
    `https://www.linkedin.com/in/${s}`,
    `https://linkedin.com/in/${s}`,
    `http://linkedin.com/in/${s}`,
  ];
}
