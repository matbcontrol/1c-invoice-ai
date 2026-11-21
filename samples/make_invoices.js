// Строит образцы входящих документов поставщиков (PDF), ответы модели для мока API Claude
// и ожидаемые результаты тестов. Данные берутся из выгрузки демобазы УНФ (samples/demo_goods.tsv).
//   samples/pdf/*.pdf                PDF, как их присылают поставщики (УПД, счёт, скан)
//   samples/html/*.html              из чего напечатаны PDF
//   samples/gen/claude_fixtures.json ответ модели по SHA-256 файла: что мок вернёт на запрос
//   samples/gen/expected.json        что должны получить тесты, считается здесь, без кода обработки
// Запуск из папки проекта: node samples/make_invoices.js   (нужен Microsoft Edge для печати в PDF)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = __dirname;
const dirHtml = path.join(root, 'html');
const dirPdf = path.join(root, 'pdf');
const dirGen = path.join(root, 'gen');
[dirHtml, dirPdf, dirGen].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => fs.existsSync(p));
if (!EDGE) throw new Error('Не найден Microsoft Edge: он печатает HTML в PDF');

// ---------- Товары демобазы
const lines = fs.readFileSync(path.join(root, 'demo_goods.tsv'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const head = lines.find((l) => l.startsWith('uuid')).split('\t');
const meta = Object.fromEntries(lines.filter((l) => l.startsWith('#') && !l.startsWith('#хар\t')).map((l) => { const p = l.split('\t'); return [p[0].slice(1), p[1]]; }));
const goods = lines.filter((l) => !l.startsWith('#') && !l.startsWith('uuid') && !l.startsWith('--'))
  .map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])))
  .map((g) => ({ ...g, retail: Number(g.retail), barcodes: g.barcodes ? g.barcodes.split(',') : [] }));
const byArticle = (a) => { const g = goods.find((x) => x.article === a && x.articleCount === '1'); if (!g) throw new Error('нет товара ' + a); return g; };
const withArticle = goods.filter((g) => g.article && g.articleCount === '1' && g.retail > 0 && !/Перчатки/.test(g.name))
  .sort((a, b) => a.article.localeCompare(b.article, 'ru', { numeric: true }));

// ---------- Реквизиты
const innOk = (inn) => {
  const d = inn.split('').map(Number);
  const k = (w) => (w.reduce((s, x, i) => s + x * d[i], 0) % 11) % 10;
  if (d.length === 10) return k([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  if (d.length === 12) return k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  return false;
};
// ИНН физлица или ИП (12 цифр) с верными контрольными цифрами, для проверки правил. Регион 00 не существует,
// поэтому номер не может принадлежать настоящему человеку, как и ИНН вымышленных компаний ниже.
const inn12 = (base10) => {
  const d = base10.split('').map(Number);
  const k = (w, ds) => (w.reduce((s, x, i) => s + x * ds[i], 0) % 11) % 10;
  d.push(k([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], d.concat([0, 0, 0])));
  d.push(k([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], d));
  return d.join('');
};
const our = { name: 'ООО "Ассоль"', inn: '7725192493', kpp: '772701001', address: '115054, г. Москва, ул. Валовая, д. 21, оф. 4' };
const sup = {
  alfa: { name: 'ООО "АЛЬФАМАРТ"', inn: '6670365488', kpp: '667001001', address: '620014, г. Екатеринбург, ул. Малышева, д. 51', bank: 'АО «Демо-Банк»', inDb: true },
  rdom: { name: 'ООО "Русский дом"', inn: '7610083466', kpp: '761001001', address: '152901, Ярославская обл., г. Рыбинск, ул. Крестовая, д. 12', bank: 'АО «Демо-Банк»', inDb: true },
  tech: { name: 'ООО "ТехноСтрой"', inn: '7813429656', kpp: '781301001', address: '197101, г. Санкт-Петербург, ул. Мира, д. 3, лит. А', bank: 'АО «Демо-Банк»', inDb: true },
  hoz: { name: 'ООО "ХозОптТорг"', inn: '0045123789', kpp: '004501001', address: '105064, г. Москва, Земляной Вал, д. 9', bank: 'АО «Демо-Банк»', inDb: false },
};
const otherBuyer = { name: 'ООО "Ромашка-Сервис"', inn: '0059302146', kpp: '005901001', address: '143401, Московская обл., г. Красногорск, ул. Ленина, д. 4' };
for (const [k, s] of Object.entries({ ...sup, our, otherBuyer })) if (!innOk(s.inn)) throw new Error(`ИНН ${k} ${s.inn} не проходит проверку`);

// ---------- Деньги
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const purchase = (g) => r2(g.retail * 0.62);
const rateNum = (r) => (r === 'без НДС' ? 0 : Number(r.replace('%', '')));

// Строка документа. В УПД цена и сумма без налога, в счёте на оплату (inclVat) с налогом.
function line(n, o) {
  const qty = o.qty;
  const price = o.price;
  const rate = o.vat || '22%';
  const amount = o.amount !== undefined ? o.amount : r2(qty * price);
  let vat;
  let total;
  if (o.inclVat) { vat = r2(amount * rateNum(rate) / (100 + rateNum(rate))); total = amount; } else { vat = r2(amount * rateNum(rate) / 100); total = r2(amount + vat); }
  return {
    line_no: n, name: o.name, supplier_code: o.code || '', barcode: o.barcode || '', unit: 'шт', okei: '796',
    quantity: qty, price, amount, vat_rate: rate, vat_amount: vat, amount_with_vat: total,
    _match: o.match, _uuid: o.good ? o.good.uuid : '', _wrong: !!o.wrong,
  };
}
const totals = (ls, inclVat) => ({
  total_without_vat: r2(ls.reduce((s, l) => s + (inclVat ? l.amount - l.vat_amount : l.amount), 0)),
  total_vat: r2(ls.reduce((s, l) => s + l.vat_amount, 0)),
  total_with_vat: r2(ls.reduce((s, l) => s + l.amount_with_vat, 0)),
});

// ---------- Документы
const docs = [];
function doc(o) {
  const t = totals(o.lines, o.inclVat);
  const d = { ...o, ...t };
  docs.push(d);
  return d;
}

// 1. Обычный УПД: товары находятся по артикулу, штрихкоду, наименованию; один товар новый.
const g1485 = byArticle('1485');
doc({
  file: 'УПД АЛЬФАМАРТ 1245 от 18.11.2026.pdf', key: 'upd1', kind: 'upd', number: '1245', date: '2026-11-18', seller: sup.alfa, buyer: our,
  lines: [
    line(1, { code: '1481', name: 'Мешки хозяйственные двухслойные (до 70кг) ("AVIKOMP")', qty: 20, price: purchase(byArticle('1481')), good: byArticle('1481'), match: 'артикул' }),
    line(2, { code: '1483', name: 'Мешки хозяйственные ПРОФИ черные ("AVIKOMP"), 160л/10шт', qty: 30, price: purchase(byArticle('1483')), good: byArticle('1483'), match: 'артикул' }),
    line(3, { code: '2740', name: 'Доска гладильная НИКА 9 (МЕТАЛЛ)', qty: 4, price: purchase(byArticle('2740')), good: byArticle('2740'), match: 'артикул' }),
    line(4, { code: 'АМ-55210', barcode: '2000000000039', name: 'Доска гладильная НИКА 10+ металл', qty: 3, price: purchase(byArticle('2741')), good: byArticle('2741'), match: 'штрихкод' }),
    line(5, { code: 'АМ-55388', barcode: '2000000000060', name: 'Набор для подметания ТАНДЕМ YORK', qty: 6, price: purchase(byArticle('3621')), good: byArticle('3621'), match: 'штрихкод' }),
    line(6, { code: 'АМ-14851', name: g1485.name.replace(/"Концепция быта"/, '«Концепция быта»').replace(/ПРОФИ/, 'ПРОФИ ').replace(/  /g, ' '), qty: 25, price: purchase(g1485), good: g1485, match: 'наименование' }),
    line(7, { code: 'АМ-77015', name: 'Перчатки нитриловые хозяйственные, р. M, 50 пар', qty: 10, price: 389.5, match: 'нет' }),
    line(8, { code: '1487', name: 'Мешки для мусора ПРОФИ в рулоне "Концепция быта"', qty: 10, price: purchase(byArticle('1487')), good: byArticle('1487'), match: 'артикул' }),
  ],
});

// 2. Двухстраничный УПД на 36 строк. Последняя строка тот же новый товар, что и в документе 1:
//    после того как его сопоставят вручную, он должен найтись по соответствию поставщика.
const many = withArticle.filter((g) => !['1481', '1483', '2740', '1487', '1485', '2741', '3621'].includes(g.article)).slice(0, 35);
doc({
  file: 'УПД АЛЬФАМАРТ 1302 от 20.11.2026.pdf', key: 'upd2', kind: 'upd', number: '1302', date: '2026-11-20', seller: sup.alfa, buyer: our,
  lines: many.map((g, i) => line(i + 1, { code: g.article, name: g.name, qty: 2 + (i % 7), price: purchase(g), good: g, match: 'артикул' }))
    .concat([line(36, { code: 'АМ-77015', name: 'Перчатки нитриловые хозяйственные, р. M, 50 пар', qty: 5, price: 389.5, match: 'соответствие' })]),
});

// 3. Ошибка у поставщика: в строке 3 сумма не равна количеству на цену, итоги посчитаны с этой суммой.
const g3 = [byArticle('1484'), byArticle('1486'), byArticle('2744'), byArticle('2745'), byArticle('2746')];
const l3 = g3.map((g, i) => line(i + 1, { code: g.article, name: g.name, qty: [15, 20, 12, 2, 3][i], price: purchase(g), good: g, match: 'артикул' }));
const wrong = l3[2];
wrong.amount = r2(wrong.quantity * wrong.price + 18);   // переставлены цифры в сумме
wrong.vat_amount = r2(wrong.amount * 0.22);
wrong.amount_with_vat = r2(wrong.amount + wrong.vat_amount);
wrong._wrong = true;
doc({ file: 'УПД Русский дом РД-0457 от 19.11.2026.pdf', key: 'rdom_err', kind: 'upd', number: 'РД-0457', date: '2026-11-19', seller: sup.rdom, buyer: our, lines: l3 });

// 4. Новый поставщик: в 1С его ещё нет.
const g4 = [byArticle('1482'), byArticle('2741'), byArticle('1486')];
doc({
  file: 'УПД ХозОптТорг 58 от 17.11.2026.pdf', key: 'newsup', kind: 'upd', number: '58', date: '2026-11-17', seller: sup.hoz, buyer: our,
  lines: g4.map((g, i) => line(i + 1, { code: g.article, name: g.name, qty: [40, 2, 12][i], price: r2(purchase(g) * 0.97), good: g, match: 'артикул' })),
});

// 5. Документ выставлен другой организации (пришёл не тому адресату).
const g5 = [byArticle('1481'), byArticle('1483')];
doc({
  file: 'УПД АЛЬФАМАРТ 1251 от 18.11.2026.pdf', key: 'otherbuyer', kind: 'upd', number: '1251', date: '2026-11-18', seller: sup.alfa, buyer: otherBuyer,
  lines: g5.map((g, i) => line(i + 1, { code: g.article, name: g.name, qty: [100, 60][i], price: purchase(g), good: g, match: 'артикул' })),
});

// 6. Скан (только картинка, без текстового слоя). Модель прочитала одну цифру ИНН неверно и сказала об этом.
const g6 = [byArticle('1484'), byArticle('1487')];
doc({
  file: 'Скан УПД Русский дом РД-0461.pdf', key: 'scan', kind: 'upd', number: 'РД-0461', date: '2026-11-20', seller: sup.rdom, buyer: our, scan: true,
  lines: g6.map((g, i) => line(i + 1, { code: g.article, name: g.name, qty: [10, 8][i], price: purchase(g), good: g, match: 'артикул' })),
});

// 7. Счёт на оплату от поставщика на УСН: НДС 5 %, цены с НДС.
const g7 = [byArticle('2740'), byArticle('2744'), byArticle('3621'), byArticle('1482')];
doc({
  file: 'Счёт ТехноСтрой 215 от 19.11.2026.pdf', key: 'usn', kind: 'invoice', number: '215', date: '2026-11-19', seller: sup.tech, buyer: our, inclVat: true,
  lines: g7.map((g, i) => line(i + 1, { code: g.article, name: g.name, qty: [2, 1, 5, 10][i], price: r2(purchase(g) * 1.05), inclVat: true, vat: '5%', good: g, match: 'артикул' })),
});

// 8. Для проверки пакетного запуска: новый документ, все товары находятся по артикулу.
const g8 = [byArticle('1481'), byArticle('1486'), byArticle('2745')];
doc({
  file: 'УПД АЛЬФАМАРТ 1310 от 21.11.2026.pdf', key: 'batch', kind: 'upd', number: '1310', date: '2026-11-21', seller: sup.alfa, buyer: our, batchOnly: true,
  lines: g8.map((g, i) => line(i + 1, { code: g.article, name: g.name, qty: [50, 20, 1][i], price: purchase(g), good: g, match: 'артикул' })),
});

// ---------- HTML
const money =(x) => x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u00a0/g, ' ');
const qty = (x) => String(x);
const ruDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const longDate = (iso) => { const [y, m, d] = iso.split('-'); return `«${d}» ${months[Number(m) - 1]} ${y} г.`; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const css = `
@page { size: A4 landscape; margin: 10mm; }
body { font-family: Arial, sans-serif; font-size: 9px; color: #111; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #333; padding: 2px 3px; vertical-align: top; }
th { font-weight: normal; font-size: 8px; text-align: center; }
.num { text-align: right; white-space: nowrap; }
.c { text-align: center; }
.hdr td { border: none; padding: 1px 3px; }
.hdr .v { border-bottom: 1px solid #333; }
.status { border: 1px solid #333; padding: 3px 6px; width: 60px; }
h1 { font-size: 13px; margin: 0 0 4px; }
.sign td { border: none; padding-top: 12px; }
.line { border-bottom: 1px solid #333; display: inline-block; min-width: 120px; }
tr { page-break-inside: avoid; }
`;

function htmlUpd(d) {
  const rows = d.lines.map((l) => `<tr><td class="c">${l.line_no}</td><td>${esc(l.supplier_code)}</td><td>${esc(l.name)}${l.barcode ? `<br><span style="font-size:8px">Штрихкод ${l.barcode}</span>` : ''}</td><td class="c">--</td>
<td class="c">${l.okei}</td><td class="c">${l.unit}</td><td class="num">${qty(l.quantity)}</td><td class="num">${money(l.price)}</td><td class="num">${money(l.amount)}</td>
<td class="c">без акциза</td><td class="c">${l.vat_rate}</td><td class="num">${money(l.vat_amount)}</td><td class="num">${money(l.amount_with_vat)}</td><td class="c">--</td></tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}${d.scan ? 'body{background:#f1efe8;}' : ''}</style></head><body>
<table class="hdr"><tr><td rowspan="2" style="width:90px;vertical-align:middle"><b>Универсальный передаточный документ</b><br><br><span class="status">Статус: 1</span></td>
<td><h1>Счёт-фактура № ${esc(d.number)} от ${ruDate(d.date)}</h1>Исправление № -- от --</td></tr></table>
<table class="hdr">
<tr><td style="width:190px">Продавец:</td><td class="v">${esc(d.seller.name)}</td></tr>
<tr><td>Адрес:</td><td class="v">${esc(d.seller.address)}</td></tr>
<tr><td>ИНН/КПП продавца:</td><td class="v">${d.seller.inn}/${d.seller.kpp}</td></tr>
<tr><td>Грузоотправитель и его адрес:</td><td class="v">он же</td></tr>
<tr><td>Грузополучатель и его адрес:</td><td class="v">${esc(d.buyer.name)}, ${esc(d.buyer.address)}</td></tr>
<tr><td>К платёжно-расчётному документу №</td><td class="v">--</td></tr>
<tr><td>Покупатель:</td><td class="v">${esc(d.buyer.name)}</td></tr>
<tr><td>Адрес:</td><td class="v">${esc(d.buyer.address)}</td></tr>
<tr><td>ИНН/КПП покупателя:</td><td class="v">${d.buyer.inn}/${d.buyer.kpp}</td></tr>
<tr><td>Валюта: наименование, код</td><td class="v">Российский рубль, 643</td></tr>
</table><br>
<table><thead><tr><th>№ п/п</th><th>Код товара / работ, услуг</th><th style="width:28%">Наименование товара (описание выполненных работ, оказанных услуг), имущественного права</th><th>Код вида товара</th>
<th>Единица измерения: код</th><th>условное обозначение</th><th>Количество (объём)</th><th>Цена (тариф) за единицу измерения</th><th>Стоимость товаров (работ, услуг), имущественных прав без налога, всего</th>
<th>В том числе сумма акциза</th><th>Налоговая ставка</th><th>Сумма налога, предъявляемая покупателю</th><th>Стоимость товаров (работ, услуг), имущественных прав с налогом, всего</th><th>Страна происхождения</th></tr>
<tr>${[...Array(14)].map((_, i) => `<th>${i + 1}</th>`).join('')}</tr></thead>
<tbody>${rows}
<tr><td colspan="8"><b>Всего к оплате</b></td><td class="num"><b>${money(d.total_without_vat)}</b></td><td class="c">X</td><td></td><td class="num"><b>${money(d.total_vat)}</b></td><td class="num"><b>${money(d.total_with_vat)}</b></td><td></td></tr>
</tbody></table>
<table class="sign"><tr><td>Руководитель организации <span class="line"></span></td><td>Главный бухгалтер <span class="line"></span></td></tr>
<tr><td>Товар (груз) передал <span class="line"></span> ${longDate(d.date)}</td><td>Товар (груз) получил <span class="line"></span></td></tr></table>
</body></html>`;
}

function htmlInvoice(d) {
  const rows = d.lines.map((l) => `<tr><td class="c">${l.line_no}</td><td>${esc(l.supplier_code)}</td><td>${esc(l.name)}</td><td class="num">${qty(l.quantity)}</td><td class="c">${l.unit}</td>
<td class="num">${money(l.price)}</td><td class="num">${money(l.amount)}</td></tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}@page{size:A4 portrait;} body{font-size:11px}</style></head><body>
<table><tr><td colspan="2">${esc(d.seller.bank)}<br><span style="font-size:9px">Банк получателя</span></td><td>БИК</td><td>049999999</td></tr>
<tr><td>ИНН ${d.seller.inn}</td><td>КПП ${d.seller.kpp}</td><td>Сч. №</td><td>40702810400000012345</td></tr>
<tr><td colspan="2">${esc(d.seller.name)}<br><span style="font-size:9px">Получатель</span></td><td></td><td></td></tr></table>
<h1 style="font-size:16px;margin:14px 0">Счёт на оплату № ${esc(d.number)} от ${longDate(d.date)}</h1>
<p>Поставщик (исполнитель): <b>${esc(d.seller.name)}, ИНН ${d.seller.inn}, КПП ${d.seller.kpp}, ${esc(d.seller.address)}</b></p>
<p>Покупатель (заказчик): <b>${esc(d.buyer.name)}, ИНН ${d.buyer.inn}, КПП ${d.buyer.kpp}, ${esc(d.buyer.address)}</b></p>
<table><thead><tr><th>№</th><th>Артикул</th><th style="width:50%">Товары (работы, услуги)</th><th>Кол-во</th><th>Ед.</th><th>Цена</th><th>Сумма</th></tr></thead>
<tbody>${rows}</tbody></table>
<table class="hdr" style="width:45%;margin-left:55%"><tr><td class="num"><b>Итого:</b></td><td class="num"><b>${money(d.total_with_vat)}</b></td></tr>
<tr><td class="num"><b>В том числе НДС (${d.lines[0].vat_rate}):</b></td><td class="num"><b>${money(d.total_vat)}</b></td></tr>
<tr><td class="num"><b>Всего к оплате:</b></td><td class="num"><b>${money(d.total_with_vat)}</b></td></tr></table>
<p>Всего наименований ${d.lines.length}, на сумму ${money(d.total_with_vat)} руб.</p>
<p>Поставщик применяет УСН, НДС исчислен по ставке 5 % (п. 8 ст. 164 НК РФ).</p>
<table class="sign"><tr><td>Руководитель <span class="line"></span></td><td>Бухгалтер <span class="line"></span></td></tr></table>
</body></html>`;
}

const url = (p) => 'file:///' + p.replace(/\\/g, '/');
function printPdf(htmlPath, pdfPath) {
  execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, url(htmlPath)], { stdio: 'ignore' });
  if (!fs.existsSync(pdfPath)) throw new Error('Edge не напечатал ' + pdfPath);
}
// Скан: страница снимается картинкой, картинка кладётся в PDF. Текстового слоя нет, как у настоящего скана.
function printScan(htmlPath, pdfPath) {
  const png = htmlPath.replace(/\.html$/, '.png');
  execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1500,1000', `--screenshot=${png}`, url(htmlPath)], { stdio: 'ignore' });
  const wrap = htmlPath.replace(/\.html$/, '_scan.html');
  const img = fs.readFileSync(png).toString('base64');
  fs.writeFileSync(wrap, `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4 landscape;margin:0}body{margin:0}
img{width:100%;transform:rotate(0.7deg);filter:grayscale(1) contrast(0.85) blur(0.35px)}</style></head><body><img src="data:image/png;base64,${img}"></body></html>`);
  printPdf(wrap, pdfPath);
  fs.unlinkSync(png);
  fs.unlinkSync(wrap);
}

// ---------- Ответ модели: то, что напечатано в документе, по схеме обработки.
const party = (p) => ({ name: p.name, inn: p.inn, kpp: p.kpp });
function modelOutput(d) {
  const out = {
    document_type: d.kind === 'invoice' ? 'invoice_for_payment' : 'upd',
    number: d.number, date: d.date,
    seller: party(d.seller), buyer: party(d.buyer),
    currency: 'RUB', prices_include_vat: !!d.inclVat,
    lines: d.lines.map((l) => ({
      line_no: l.line_no, supplier_code: l.supplier_code, name: l.name, barcode: l.barcode, unit: l.unit, okei: l.okei,
      quantity: l.quantity, price: l.price, amount: l.amount, vat_rate: l.vat_rate, vat_amount: l.vat_amount, amount_with_vat: l.amount_with_vat,
    })),
    total_without_vat: d.total_without_vat, total_vat: d.total_vat, total_with_vat: d.total_with_vat,
    unreadable: [],
  };
  if (d.scan) {
    // В скане размыта седьмая цифра ИНН продавца: 3 прочитана как 8. Модель честно пишет, что не уверена.
    out.seller.inn = d.seller.inn.slice(0, 6) + '8' + d.seller.inn.slice(7);
    if (innOk(out.seller.inn)) throw new Error('искажённый ИНН случайно прошёл проверку');
    out.unreadable = ['ИНН продавца: седьмая цифра в скане читается неуверенно'];
  }
  // Ответ обязан проходить схему обработки (СхемаОтвета): иначе мок отдал бы то, чего API не вернёт.
  const enums = { document_type: ['upd', 'invoice_for_payment', 'torg12', 'other'], vat_rate: ['22%', '20%', '10%', '7%', '5%', '0%', 'без НДС'] };
  if (!enums.document_type.includes(out.document_type)) throw new Error('document_type вне схемы: ' + out.document_type);
  for (const l of out.lines) if (!enums.vat_rate.includes(l.vat_rate)) throw new Error('vat_rate вне схемы: ' + l.vat_rate);
  return out;
}

// ---------- Печать и фикстуры
const fixtures = {};
for (const d of docs) {
  const base = d.file.replace(/\.pdf$/, '');
  const htmlPath = path.join(dirHtml, base + '.html');
  const pdfPath = path.join(dirPdf, d.file);
  fs.writeFileSync(htmlPath, d.kind === 'invoice' ? htmlInvoice(d) : htmlUpd(d));
  if (d.scan) printScan(htmlPath, pdfPath); else printPdf(htmlPath, pdfPath);
  const bytes = fs.readFileSync(pdfPath);
  d.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  d.pages = pages;
  fixtures[d.sha256] = { file: d.file, pages, output: modelOutput(d) };
}

// ---------- Ожидаемые результаты
const count = (ls, m) => ls.filter((l) => l._match === m).length;
const expected = {
  meta: { ...meta, organizationInn: our.inn },
  suppliers: Object.fromEntries(Object.entries(sup).map(([k, s]) => [k, { inn: s.inn, kpp: s.kpp, name: s.name, inDb: s.inDb }])),
  docs: Object.fromEntries(docs.map((d) => [d.key, {
    file: d.file, number: d.number, date: d.date, pages: d.pages, sellerInn: d.seller.inn, buyerInn: d.buyer.inn,
    lines: d.lines.length,
    byArticle: count(d.lines, 'артикул'), byBarcode: count(d.lines, 'штрихкод'), byName: count(d.lines, 'наименование'),
    bySupplierMap: count(d.lines, 'соответствие'), notFound: count(d.lines, 'нет'),
    wrongLines: d.lines.filter((l) => l._wrong).map((l) => l.line_no),
    totalWithoutVat: d.total_without_vat, totalVat: d.total_vat, totalWithVat: d.total_with_vat,
    pricesIncludeVat: !!d.inclVat, vatRate: d.lines[0].vat_rate,
    rows: d.lines.map((l) => ({ line: l.line_no, uuid: l._uuid, match: l._match, quantity: l.quantity, price: l.price, amount: l.amount, vat: l.vat_amount, total: l.amount_with_vat })),
  }])),
  unknownCode: 'АМ-77015',
  unknownMapsTo: byArticle('9689').uuid,   // тест сопоставляет новые перчатки с имеющимся товаром вручную
  scanReadInn: modelOutput(docs.find((d) => d.scan)).seller.inn,
  inn12Valid: inn12('0012345678'), inn12Invalid: inn12('0012345678').slice(0, 11) + String((Number(inn12('0012345678')[11]) + 1) % 10),
  apiKey: 'sk-ant-api03-mock-key-for-tests-only',
};
fs.writeFileSync(path.join(dirGen, 'claude_fixtures.json'), JSON.stringify(fixtures, null, 1));
fs.writeFileSync(path.join(dirGen, 'expected.json'), JSON.stringify(expected, null, 1));
for (const d of docs) console.log(`${d.file}: страниц ${d.pages}, строк ${d.lines.length}, всего ${money(d.total_with_vat)}, sha ${d.sha256.slice(0, 12)}`);
