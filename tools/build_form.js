// Генерирует Form.xml формы обработки «Документы поставщиков из PDF».
// Запуск: node tools/build_form.js "src/РазборДокументовПоставщиков/Forms/Форма/Ext/Form.xml"
const fs = require('fs');

let id = 0;
const next = () => ++id;
const ru = (t) => `<v8:item><v8:lang>ru</v8:lang><v8:content>${t}</v8:content></v8:item>`;
const title = (t) => `<Title>${ru(t)}</Title>`;
const cm = (n) => `<ContextMenu name="${n}КонтекстноеМеню" id="${next()}"/>`;
const tip = (n) => `<ExtendedTooltip name="${n}РасширеннаяПодсказка" id="${next()}"/>`;
const events = (list) => (list && list.length ? `<Events>${list.map(([e, h]) => `<Event name="${e}">${h}</Event>`).join('')}</Events>` : '');

function input(name, path, o = {}) {
  const p = [`<DataPath>${path}</DataPath>`];
  if (o.readOnly) p.push('<ReadOnly>true</ReadOnly>');
  if (o.caption) p.push(title(o.caption));
  if (o.titleLoc) p.push(`<TitleLocation>${o.titleLoc}</TitleLocation>`);
  if (o.width) p.push(`<Width>${o.width}</Width>`);
  if (o.height) p.push(`<Height>${o.height}</Height>`);
  if (o.multiLine) p.push('<MultiLine>true</MultiLine>');
  if (o.password) p.push('<PasswordMode>true</PasswordMode>');
  if (o.hint) p.push(`<InputHint>${ru(o.hint)}</InputHint>`);
  return `<InputField name="${name}" id="${next()}">${p.join('')}${cm(name)}${tip(name)}${events(o.events)}</InputField>`;
}

function checkbox(name, path, o = {}) {
  const p = [`<DataPath>${path}</DataPath>`];
  if (o.caption) p.push(title(o.caption));
  p.push(`<TitleLocation>${o.titleLoc || 'Right'}</TitleLocation>`);
  p.push('<CheckBoxType>Auto</CheckBoxType>');
  return `<CheckBoxField name="${name}" id="${next()}">${p.join('')}${cm(name)}${tip(name)}${events(o.events)}</CheckBoxField>`;
}

function group(name, caption, kind, children, o = {}) {
  return `<UsualGroup name="${name}" id="${next()}">${title(caption)}<Group>${kind}</Group><Representation>${o.repr || 'None'}</Representation><ShowTitle>${o.showTitle ? 'true' : 'false'}</ShowTitle>${tip(name)}<ChildItems>${children.join('')}</ChildItems></UsualGroup>`;
}

function page(name, caption, children) {
  return `<Page name="${name}" id="${next()}">${title(caption)}<Group>Vertical</Group><ShowTitle>true</ShowTitle>${tip(name)}<ChildItems>${children.join('')}</ChildItems></Page>`;
}

function pages(name, children) {
  return `<Pages name="${name}" id="${next()}">${title('Страницы')}<PagesRepresentation>TabsOnTop</PagesRepresentation>${tip(name)}<ChildItems>${children.join('')}</ChildItems></Pages>`;
}

function addition(tableName, kind, suffix) {
  const n = tableName + suffix;
  const type = kind === 'SearchStringAddition' ? 'SearchStringRepresentation' : kind === 'ViewStatusAddition' ? 'ViewStatusRepresentation' : 'SearchControl';
  return `<${kind} name="${n}" id="${next()}"><AdditionSource><Item>${tableName}</Item><Type>${type}</Type></AdditionSource>${cm(n)}${tip(n)}</${kind}>`;
}

function table(name, columns, o = {}) {
  const head = `<Table name="${name}" id="${next()}"><Representation>List</Representation>${o.title ? title(o.title) : ''}<ChangeRowSet>false</ChangeRowSet><ChangeRowOrder>false</ChangeRowOrder>${o.height ? `<Height>${o.height}</Height>` : ''}<DataPath>${name}</DataPath>`;
  const parts = [cm(name), `<AutoCommandBar name="${name}КоманднаяПанель" id="${next()}"/>`, tip(name),
    addition(name, 'SearchStringAddition', 'СтрокаПоиска'),
    addition(name, 'ViewStatusAddition', 'СостояниеПросмотра'),
    addition(name, 'SearchControlAddition', 'УправлениеПоиском')];
  // Как в корне формы: события идут перед дочерними элементами.
  return head + parts.join('') + `${events(o.events)}<ChildItems>${columns.join('')}</ChildItems></Table>`;
}

function button(name, command, isDefault) {
  return `<Button name="${name}" id="${next()}"><Type>UsualButton</Type>${isDefault ? '<DefaultButton>true</DefaultButton>' : ''}<CommandName>${command}</CommandName>${tip(name)}</Button>`;
}

// Типы.
const str = (len = 0) => `<v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>${len}</v8:Length><v8:AllowedLength>Variable</v8:AllowedLength></v8:StringQualifiers>`;
const num = (d, f, sign = 'Any') => `<v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>${d}</v8:Digits><v8:FractionDigits>${f}</v8:FractionDigits><v8:AllowedSign>${sign}</v8:AllowedSign></v8:NumberQualifiers>`;
const bool = () => '<v8:Type>xs:boolean</v8:Type>';
const date = () => '<v8:Type>xs:dateTime</v8:Type><v8:DateQualifiers><v8:DateFractions>Date</v8:DateFractions></v8:DateQualifiers>';
const ref = (t) => `<v8:Type>cfg:${t}</v8:Type>`;

let attrId = 0;
const attr = (name, caption, type, extra = '') => `<Attribute name="${name}" id="${++attrId}">${caption ? title(caption) : ''}<Type>${type}</Type>${extra}</Attribute>`;
let colId = 0;
const valueTable = (name, caption, cols) => `<Attribute name="${name}" id="${++attrId}">${title(caption)}<Type><v8:Type>v8:ValueTable</v8:Type></Type><Columns>${
  cols.map(([n, t]) => `<Column name="${n}" id="${++colId}"><Type>${t}</Type></Column>`).join('')}</Columns></Attribute>`;

// Колонки совпадают с НоваяТаблицаДокументов и НоваяТаблицаСтрок модуля объекта.
const docCols = [
  ['Применить', bool()], ['Статус', str(30)], ['ИдФайла', num(5, 0)], ['Файл', str(250)], ['Тип', str(30)], ['Номер', str(50)], ['Дата', date()],
  ['ПродавецНаименование', str(250)], ['ПродавецИНН', str(12)], ['ПродавецКПП', str(9)], ['ПокупательНаименование', str(250)], ['ПокупательИНН', str(12)],
  ['Поставщик', ref('CatalogRef.Контрагенты')], ['ЦеныСНДС', bool()], ['СуммаБезНДС', num(15, 2)], ['СуммаНДС', num(15, 2)], ['Всего', num(15, 2)],
  ['Строк', num(5, 0)], ['Нечитаемо', str(500)], ['Модель', str(50)], ['ТокеновВход', num(10, 0)], ['ТокеновВыход', num(10, 0)],
  ['Документ1С', ref('DocumentRef.ПриходнаяНакладная')], ['Пояснение', str(1000)],
];
const lineCols = [
  ['ИдФайла', num(5, 0)], ['НомерСтроки', num(5, 0)], ['Статус', str(30)], ['КодПоставщика', str(50)], ['Наименование', str(500)], ['Штрихкод', str(50)],
  ['Единица', str(20)], ['ОКЕИ', str(5)], ['Количество', num(15, 3)], ['Цена', num(15, 2)], ['Сумма', num(15, 2)], ['СтавкаНДС', str(10)],
  ['СуммаНДС', num(15, 2)], ['Всего', num(15, 2)], ['Номенклатура', ref('CatalogRef.Номенклатура')], ['КакНайдена', str(20)], ['Пояснение', str(500)],
];

const col = (t, n, cap, w) => input(t + n, t + '.' + n, { readOnly: true, caption: cap, width: w });

// Строки документа показываются по текущей строке верхней таблицы.
const docsTable = table('Документы', [
  checkbox('ДокументыПрименить', 'Документы.Применить', { caption: 'Создать', titleLoc: 'None' }),
  col('Документы', 'Статус', 'Статус', 11),
  col('Документы', 'Файл', 'Файл', 18),
  col('Документы', 'Тип', 'Вид', 7),
  col('Документы', 'Номер', 'Номер', 7),
  col('Документы', 'Дата', 'Дата', 7),
  col('Документы', 'ПродавецНаименование', 'Продавец', 13),
  col('Документы', 'ПродавецИНН', 'ИНН', 8),
  col('Документы', 'Всего', 'Всего, руб.', 8),
  col('Документы', 'Документ1С', 'Документ в 1С', 14),
  col('Документы', 'Пояснение', 'Пояснение', 32),
], { events: [['OnActivateRow', 'ДокументыПриАктивизацииСтроки']] });

const linesTable = table('Строки', [
  col('Строки', 'НомерСтроки', '№', 3),
  col('Строки', 'Статус', 'Статус', 10),
  col('Строки', 'КодПоставщика', 'Код поставщика', 7),
  col('Строки', 'Наименование', 'Наименование в документе', 24),
  col('Строки', 'Количество', 'Кол-во', 5),
  col('Строки', 'Цена', 'Цена', 6),
  col('Строки', 'Сумма', 'Сумма', 7),
  col('Строки', 'СтавкаНДС', 'НДС', 4),
  col('Строки', 'Всего', 'Всего', 7),
  input('СтрокиНоменклатура', 'Строки.Номенклатура', { caption: 'Товар в 1С', width: 22, events: [['OnChange', 'СтрокиНоменклатураПриИзменении']] }),
  col('Строки', 'КакНайдена', 'Найден по', 7),
  col('Строки', 'Пояснение', 'Пояснение', 22),
], { title: 'Строки выбранного документа', height: 7 });

const docsPage = page('СтраницаДокументы', 'Документы', [
  group('ГруппаКоманды', 'Команды', 'AlwaysHorizontal', [
    button('КнопкаВыбратьФайлы', 'Form.Command.ВыбратьФайлы'),
    button('КнопкаРазобрать', 'Form.Command.Разобрать', true),
    button('КнопкаСоздатьДокументы', 'Form.Command.СоздатьДокументы'),
    button('КнопкаПроверитьСнова', 'Form.Command.ПроверитьСнова'),
  ]),
  input('ВыбраноФайлов', 'ВыбраноФайлов', { readOnly: true, titleLoc: 'None' }),
  input('СводкаДокументов', 'СводкаДокументов', { readOnly: true, titleLoc: 'None', multiLine: true, height: 2 }),
  docsTable,
  linesTable,
]);

const onParam = [['OnChange', 'НастройкаПриИзменении']];
const settingsPage = page('СтраницаНастройки', 'Настройки', [
  group('ГруппаAPI', 'Claude API', 'Vertical', [
    input('КлючAPI', 'КлючAPI', { width: 40, password: true, hint: 'ключ из консоли Anthropic, раздел API keys', events: onParam }),
    input('Модель', 'Модель', { width: 20, events: onParam }),
    input('Усилие', 'Усилие', { width: 10, events: onParam }),
    input('МаксТокенов', 'МаксТокенов', { width: 8, events: onParam }),
    checkbox('РезервнаяМодель', 'РезервнаяМодель', { events: onParam }),
    input('АдресAPI', 'АдресAPI', { width: 40, events: onParam }),
  ], { showTitle: true, repr: 'WeakSeparation' }),
  group('ГруппаНакладные', 'Приходные накладные', 'Vertical', [
    input('Организация', 'Организация', { width: 30, events: onParam }),
    input('Склад', 'Склад', { width: 30, events: onParam }),
    checkbox('СоздаватьПоставщиков', 'СоздаватьПоставщиков', { events: onParam }),
    checkbox('ПроводитьДокументы', 'ПроводитьДокументы', { events: onParam }),
    checkbox('ПрикладыватьФайл', 'ПрикладыватьФайл', { events: onParam }),
  ], { showTitle: true, repr: 'WeakSeparation' }),
  button('КнопкаСохранитьНастройки', 'Form.Command.СохранитьНастройки'),
]);

const items = [
  pages('Страницы', [docsPage, settingsPage]),
  input('Прогресс', 'Прогресс', { readOnly: true, titleLoc: 'None' }),
];

const attributes = [
  attr('Объект', '', ref('ExternalDataProcessorObject.РазборДокументовПоставщиков'), '<MainAttribute>true</MainAttribute>'),
  attr('КлючAPI', 'Ключ API Claude', str()),
  attr('АдресAPI', 'Адрес API', str()),
  attr('Модель', 'Модель', str()),
  attr('Усилие', 'Усилие модели', str()),
  attr('МаксТокенов', 'Макс. токенов ответа', num(6, 0, 'Nonnegative')),
  attr('ТаймаутСекунд', 'Таймаут, с', num(5, 0, 'Nonnegative')),
  attr('МаксПопыток', 'Попыток при сбое', num(3, 0, 'Nonnegative')),
  attr('РезервнаяМодель', 'Резервная модель, если основная откажется', bool()),
  attr('Организация', 'Организация (покупатель)', ref('CatalogRef.Организации')),
  attr('Склад', 'Склад поступления', ref('CatalogRef.СтруктурныеЕдиницы')),
  attr('СоздаватьПоставщиков', 'Создавать поставщиков, которых нет в 1С', bool()),
  attr('ПроводитьДокументы', 'Проводить документы (иначе черновики)', bool()),
  attr('ПрикладыватьФайл', 'Прикладывать PDF к документу', bool()),
  attr('ВыбраноФайлов', '', str()),
  attr('СводкаДокументов', '', str()),
  attr('Прогресс', '', str()),
  attr('АдресСостояния', '', str()),
  attr('АдресФайлов', '', str()),
  attr('ИдетРазбор', '', bool()),
  attr('РежимПакета', '', bool()),
  attr('ПутьОтчета', '', str()),
  valueTable('Документы', 'Документы', docCols),
  valueTable('Строки', 'Строки', lineCols),
];

let cmdId = 0;
const command = (name, caption, tooltip) => `<Command name="${name}" id="${++cmdId}">${title(caption)}<ToolTip>${ru(tooltip)}</ToolTip><Action>${name}</Action><CurrentRowUse>DontUse</CurrentRowUse></Command>`;
const commands = [
  command('ВыбратьФайлы', 'Выбрать PDF', 'Выбрать один или несколько PDF от поставщиков'),
  command('Разобрать', 'Разобрать', 'Отправить PDF в Claude API, проверить реквизиты и суммы, найти товары. Ничего не записывается'),
  command('СоздатьДокументы', 'Создать документы', 'Создать приходные накладные по отмеченным документам, PDF приложить к накладной'),
  command('ПроверитьСнова', 'Проверить снова', 'Повторить проверки после того, как вручную выбрали товары'),
  command('СохранитьНастройки', 'Сохранить настройки', 'Сохранить настройки, ключ API попадёт в безопасное хранилище'),
];

const ns = 'xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" xmlns:dcssch="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:pal="http://v8.1c.ru/8.1/data/ui/colors/palette" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.21"';

const xml = `﻿<?xml version="1.0" encoding="UTF-8"?>
<Form ${ns}>
${title('Документы поставщиков из PDF')}
<WindowOpeningMode>LockOwner</WindowOpeningMode>
<AutoTitle>false</AutoTitle>
<Group>Vertical</Group>
<CommandBarLocation>None</CommandBarLocation>
<AutoCommandBar name="ФормаКоманднаяПанель" id="-1"/>
${events([['OnOpen', 'ПриОткрытии'], ['OnCreateAtServer', 'ПриСозданииНаСервере']])}
<ChildItems>${items.join('\n')}</ChildItems>
<Attributes>${attributes.join('\n')}</Attributes>
<Commands>${commands.join('\n')}</Commands>
</Form>
`;
fs.writeFileSync(process.argv[2], xml, 'utf8');
console.log('written', process.argv[2], 'ids', id);
