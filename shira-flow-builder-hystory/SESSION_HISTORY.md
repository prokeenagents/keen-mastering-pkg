# Session History — Shira Flow Builder

Последна актуализация: 2026-09-12 (корекции след engine audit; виж §11)  
Език на работа: български  
Статус: двата изградени примера работят

## 1. Контекст и собственост

Потребителят е авторът и собственикът на системата Shira Flow Builder. Той е изградил самата платформа, flow editor-а и debugger-ите. Codex работи като изпълнител и технически сътрудник вътре в неговата система.

Потвърдено е, че Codex може успешно да изгражда `.flow` файлове, script tools, flow tools и вложени agent loops за тази система. Потребителят може да проследява изпълнението node по node и да влиза директно в JavaScript кода чрез собствените си debugger-и.

Предпочитан начин на работа:

- Да се четат локалните документи внимателно и отново след update.
- При ясно зададена задача да се пише кодът директно, вместо да се иска излишно потвърждение.
- Да се пазят съществуващите файлове и потребителските промени.
- След важна задача да се оставят подробни бележки за откритията.
- Задължителни системни approval диалози може все пак да се появят, когато средата ги изисква.

## 2. Важни директории

Документация:

- `/home/n-ministation/Desktop/keen-admin-guide`
- `/home/n-ministation/Desktop/shira-flow-builder-guide`

Работен проект:

- `/home/n-ministation/Desktop/Building`
- source root: `/home/n-ministation/Desktop/Building/src`

Технически бележки от отделните задачи:

- `/home/n-ministation/Desktop/shira-flow-builder-notes/current-weather-tool-agent-loop/README.md`
- `/home/n-ministation/Desktop/shira-flow-builder-notes/country-info-nested-flow-tool/README.md`

Това history repo:

- `/home/n-ministation/Desktop/shira-flow-builder-hystory`

Името `hystory` е запазено точно както е поискано от потребителя.

## 3. Какво беше научено за основната система

### 3.1 Flow структура

Flow-ът е граф от nodes и edges. Обичайният минимален път е:

```text
Start Flow → Agent/Script/Condition → End Flow
```

`Start Flow` е входната точка на даден flow. `Start Node`/entry е конкретният адрес, през който системата стартира този flow. При flow tool entry-то използва формата:

```text
File-Label
```

Пример:

```text
CountryInfo-Start
```

където `CountryInfo` идва от `CountryInfo.flow`, а `Start` е label-ът на началния node.

### 3.2 Agent и tool calling

Агентът заявява tool чрез системен блок с тази обща форма:

```text
<SYSTEM CALL>
!*action
use tool
!*tool
Tool Name
!*context
{"field":"value"}
</SYSTEM CALL>
```

> Корекция (2026-09-12, проверено срещу `ms-llms-engine` `system-call-parser.ts`): по-ранната версия на
> този запис показваше формата `!*action: use tool` (двоеточие на същия ред). Тя е **obsolete и грешна** —
> parser-ът изисква ключът да е последван от whitespace (нов ред или интервал); `!*action:` не се
> разпознава като поле, блокът се parse-ва до нищо и агентът получава *"Could not parse the SYSTEM CALL
> block."* Единствената валидна форма е горната: ключ на свой ред, стойност на следващия.

Важни открития:

- `!*tool` трябва да съвпада с името в tool registry.
- `!*context` е свободен текст за engine-а (подава се непроменен на tool-а); в този проект по конвенция е валиден JSON, защото tool-овете го parse-ват и връщат корекция при невалиден.
- `!*action` описва намерението, но routing-ът се определя основно от registry type/name.
- При повече от един `<SYSTEM CALL>` системата изпълнява само първия блок. Prompt-ът трябва да кара агента да прави една tool стъпка наведнъж.
- Agent prompt-ът съдържа авторския каталог и правилата за tool-а; `keen-tools.json` е реалният runtime registry.

### 3.3 Script tool не връща автоматично резултат към LLM

Критично откритие: обикновеният JavaScript `return` приключва script execution, но сам по себе си не изпраща tool result обратно в разговора на агента.

Script tool-ът говори обратно на агента чрез:

```js
Agent.setRootAgentPrompt(agentId, {
  prompt,
  sessionID,
  requestID: Tools.generateUUID()
});
```

Това създава нов user-role prompt в agent loop-а. Затова може да се каже директно:

> Да — script-ът може да говори обратно на агента.

Още повече: script може да прочете последния response на един агент и да го подаде като prompt на друг агент. Това е основата на return bridge-а при вложения flow tool.

### 3.4 Session contract

При всеки push към агент са нужни:

- `sessionID` — с точно тази капитализация;
- `requestID` — ново UUID за всяко съобщение;
- правилният `agentId`.

Не трябва да се бъркат `sessionID`, `sessionId`, `requestID` и `requestId`. Различните вътрешни структури използват различна капитализация; API договорът на `setRootAgentPrompt` изисква `sessionID` и `requestID`.

При script tool правилната сесия на извикващия агент е:

```js
toolOptions.agentNode.flowContext.sessionId
```

Bare `flowContext.sessionId` в script tool принадлежи на самия tool flow/script execution и не е непременно сесията на агента, който очаква резултата.

### 3.5 Други общи правила

- HTTP заявките се изпълняват последователно, освен ако документацията изрично гарантира друго.
- Външните операции се ограждат с `try/catch`.
- Context-ът се валидира self-correcting: при грешка се изпраща структурирана инструкция към агента какъв JSON се очаква.
- Script-ът трябва да завърши чисто след push-а, за да може state write-ът да се flush-не.
- `dictionary` е подходящ за пренасяне на flow-local state между nodes.
- `system/session` е flat key/value хранилище и е най-безопасно за primitive стойности.
- Condition expression използва placeholders според формата на builder-а; реалният работещ пример е `${dictionary.countryInfoReady} === true`.
- Промяна в `keen-tools.json` изисква redeploy, защото registry-то влиза в компилирания bundle/init map.
- След deploy тестът трябва да е в нов chat, за да няма стар agent/session state.

## 4. Реализирана задача: Current Weather script tool

### 4.1 Цел

Главният агент да може да извика script tool за текущото време и да използва получения резултат в нормален човешки отговор.

### 4.2 Файлове

Основен script:

```text
/home/n-ministation/Desktop/Building/src/scripts/tools/weather.js
```

Tool registry entry:

```text
Current Weather
```

### 4.3 Първоначален симптом

Агентът правилно извикваше:

```json
{"city":"Bucharest"}
```

но после съобщаваше, че weather data не е дошла, и опитваше tool-а повторно.

Това изглеждаше като липсващ външен API token, но реалният проблем не беше HTTP услугата. Проблемът беше в return path-а към агента.

Неработещата идея беше само:

```js
Agent.setRootAgentPrompt(agentId, {
  prompt: `<WEATHER_RESULT>\n${JSON.stringify(result)}\n</WEATHER_RESULT>`
});
```

Липсваха правилните `sessionID` и `requestID`.

### 4.4 Работещото решение

Съобщението към агента използва неговата реална сесия:

```js
Agent.setRootAgentPrompt(agentId, {
  prompt: `<WEATHER_RESULT>\n${JSON.stringify(result)}\n</WEATHER_RESULT>`,
  sessionID: toolOptions.agentNode.flowContext.sessionId,
  requestID: Tools.generateUUID()
});
```

След това script-ът може да приключи с малък служебен return. Съдържанието на този return не е самият LLM tool result; реалният result е push-натият prompt.

### 4.5 Резултат

Weather tool loop-ът заработи. Основното преносимо знание е session contract-ът, а не конкретният weather endpoint.

Подробни бележки:

```text
/home/n-ministation/Desktop/shira-flow-builder-notes/current-weather-tool-agent-loop/README.md
```

## 5. Реализирана задача: Country Info nested flow tool

### 5.1 Цел

Изграден е вложен tool loop:

```text
Потребител
  → главен agent-one
  → flow tool „Country Info“
  → вложен country-agent
  → script tool „Country Lookup“
  → REST Countries / dataset
  → country-agent композира описание
  → return bridge
  → главен agent-one
  → потребител
```

Това е flow tool, не само script tool.

### 5.2 Работни файлове

```text
/home/n-ministation/Desktop/Building/src/flows/CountryInfo.flow
/home/n-ministation/Desktop/Building/src/scripts/countryInfo/setup.js
/home/n-ministation/Desktop/Building/src/scripts/countryInfo/returnToMain.js
/home/n-ministation/Desktop/Building/src/scripts/tools/countryLookup.js
/home/n-ministation/Desktop/Building/src/keen-tools.json
```

Основният проектен flow е:

```text
/home/n-ministation/Desktop/Building/src/flows/Project.flow
```

Agent IDs:

- главен агент: `agent-one`
- вложен агент: `country-agent`

### 5.3 Registry entries

Flow tool:

```text
name: Country Info
type: flow
entry: CountryInfo-Start
```

Script tool:

```text
name: Country Lookup
type: script
entry: tools/countryLookup.js
```

За script tool entry-то трябва да започва от `tools/`, защото е относително спрямо scripts tool loader-а.

### 5.4 Реален flow graph

```text
Start
  ↓
setup.js
  ↓
Condition: ${dictionary.countryInfoReady} === true
  ├─ true  → country-agent → returnToMain.js → End
  └─ false → End
```

`setup.js` има две роли:

1. Валидира input-а и подготвя prompt-а за `country-agent`.
2. Преди старта на вложения agent loop запазва идентичността на външния главен агент и неговата сесия.

### 5.5 Най-трудното откритие: return bridge

След като `country-agent` извика `Country Lookup`, вътрешният agent loop се re-dispatch-ва с options от вида:

```text
options: { toolResponse, promptMarker }
```

> Корекция (2026-09-12, проверено срещу engine + client source): по-ранната версия на този запис твърдеше,
> че заради това `toolOptions` „не са надеждно налични" в script node-а след вложения агент. Това е
> **obsolete**. Тези options пътуват само с re-dispatch-а на самия Agent node (LLM node) към себе си;
> финалният text continuation на агента излиза без options, а референтните клиенти (test harness,
> entanglement, agent-runner) seed-ват **всеки** nodeTask на `toolFlow` bundle от `flow.options`, когато
> той няма свои — т.е. `returnToMain.js` вижда outer pack-а `{toolContext, agentNode}` на AgentOne.
> flow-engine-ът от своя страна копира входящите options върху всички continuation nodes в същия flow.
> Pack-ът реално **липсва** само в Run Flow / Parallel под-flow, spawn-нат отвътре на tool-а, и при custom
> client, който не re-seed-ва.

Затова `returnToMain.js` не разчита **само** на:

```js
toolOptions.toolContext.agentId
```

а на outer identity, capture-ната рано в dictionary — защитен мост, който покрива и двата случая по-горе.

Работещото решение е outer identity да се capture-не преди вложения agent node:

```js
dictionary.countryInfoBridge = {
  mainAgentId,
  mainSession
};
```

След приключването на вложения агент `returnToMain.js` прави:

```js
const nested = Agent.getAgentLastResponse('country-agent').response;

Agent.setRootAgentPrompt(dictionary.countryInfoBridge.mainAgentId, {
  prompt: `<COUNTRY_INFO_RESULT>\n${nested}\n</COUNTRY_INFO_RESULT>`,
  sessionID: dictionary.countryInfoBridge.mainSession,
  requestID: Tools.generateUUID()
});
```

Това е надеждният мост:

```text
nested agent response → flow dictionary bridge → main agent session
```

### 5.6 Трите различни сесии

В тази архитектура участват три различни execution/session контекста:

| Ниво | Какво изпълнява | Коя сесия е важна |
|---|---|---|
| 1 | `agent-one` | main agent session, capture-ната от outer `toolOptions.agentNode.flowContext.sessionId` |
| 2 | `CountryInfo.flow` + `country-agent` | flow session, използвана при seed на вложения агент |
| 3 | `Country Lookup` script tool | собствен tool execution context; резултатът трябва да се върне към calling `country-agent` session от `toolOptions.agentNode.flowContext.sessionId` |

Най-честата грешка е да се използва bare `flowContext.sessionId` на ниво 3. Това връща съобщението към грешния execution context и агентът остава без tool response.

### 5.7 Вътрешният Country Lookup loop

`country-agent` получава prompt и се seed-ва със session ID на `CountryInfo.flow`:

```js
sessionID: flowContext.sessionId
```

Той извиква:

```text
Country Lookup
```

с context:

```json
{"country":"Bulgaria"}
```

`countryLookup.js` валидира context-а и при успех push-ва към calling nested agent session:

```js
Agent.setRootAgentPrompt(agentId, {
  prompt: `<COUNTRY_LOOKUP_RESULT>\n${JSON.stringify(result)}\n</COUNTRY_LOOKUP_RESULT>`,
  sessionID: toolOptions.agentNode.flowContext.sessionId,
  requestID: Tools.generateUUID()
});
```

Prompt правилата казват на агента:

- да извика lookup само ако още няма успешен резултат;
- след `<COUNTRY_LOOKUP_RESULT>` да не извиква tool-а пак;
- да композира кратко, приятно, човешко описание;
- да не измисля липсващи данни.

Това предотвратява безкраен повторен tool call.

### 5.8 REST Countries промяна и fallback

Първоначално зададеният endpoint беше:

```text
https://restcountries.com/v3.1/name/{name}?fields=name,capital,population,region,subregion,currencies,languages,flag
```

Към датата на изпълнение v3.1 endpoint-ът се оказа deprecated. След redirect можеше да се получи HTTP 200, но body-то да е error object, а не очакваният масив.

Затова проверката не трябва да е само:

```text
status === 200
```

Трябва да се валидира и response shape.

Реализацията запазва primary REST Countries заявката, но има fallback без auth към официалния open-source dataset:

```text
https://raw.githubusercontent.com/restcountries/restcountries/master/src/main/resources/countriesV3.1.json
```

Dataset-ът е приблизително 1.48 MB. От намерената държава се нормализират:

- `name.common`
- `capital[0]`
- `population`
- `region`
- `subregion`
- `currencies`
- `languages`
- `flag`

### 5.9 Transient nested agent state

Flow-ът използва правилото:

```text
skip-internal-database-interactions
```

То държи вложения agent state transient, но последният му response остава достъпен в рамките на текущото flow execution чрез:

```js
Agent.getAgentLastResponse('country-agent').response
```

Това е достатъчно за `returnToMain.js`.

### 5.10 Как беше проверено

Проверката комбинира:

- синтактична проверка на JavaScript;
- проверка на `keen-tools.json`;
- проверка на compiled flow/init map;
- deploy;
- нов chat;
- логове от платформата (live log stream);
- визуалния debugger на потребителя.

Успешният runtime път беше:

```text
AgentOne
  → countryInfoSetup
  → CountryAgent
  → virtual Country Lookup tool call
  → CountryAgent final response
  → countryInfoReturnToMain
  → AgentOne final response
  → End
```

В крайния trace нямаше `No tool response`.

Важно уточнение: стандартните logs не dump-ваха целия `toolOptions` object. Изчезването/промяната на outer options през nested loop-а беше установено чрез комбинация от engine source, flow trace и LLM/script logs. Затова early capture в dictionary е архитектурно решение, а не случайна workaround стойност.

Потребителят потвърди с debugger screenshot, че може да прескача по nodes и да разглежда кода. Визуално се виждаха setup script, condition, `CountryAgent`, return script и `End Flow`.

### 5.11 Deployment

При промяна в `keen-tools.json` е нужен redeploy. Registry-то се компилира в bundle-а и се зарежда от runtime engines; save на JSON файла сам по себе си не обновява вече работещата инстанция.

Проектът беше deploy-нат чрез същия HTTP workflow, който използва extension-ът. Успешното зареждане показа:

- 7 files;
- 14 nodes;
- 3 entries;
- 3 tools.

Deployment credentials от `.vscode/keen.json` не трябва никога да се копират в notes, Git commits, chat history или diagnostics output.

След registry/prompts промяна:

1. Validate JSON и scripts.
2. Redeploy.
3. Отвори нов chat.
4. Извикай flow tool-а.
5. Провери и двата agent loops.
6. Провери return bridge-а и финалния main-agent response.

Подробни бележки за тази задача:

```text
/home/n-ministation/Desktop/shira-flow-builder-notes/country-info-nested-flow-tool/README.md
```

Този технически файл е подробен (759 реда) и трябва да се използва при бъдещ debugging на същия pattern.

## 6. Какво показва debugger-ът на потребителя

Потребителят има собствени debugger-и върху системата. Те позволяват:

- прескачане node по node;
- разглеждане на конкретния JavaScript за node;
- проверка кой branch на Condition е избран;
- наблюдение на agent и script границите;
- сравнение на визуалния flow с runtime поведението.

Това е по-силна проверка от „получихме някакъв краен текст“. При следваща задача тестът трябва да доказва:

1. правилния node path;
2. правилния session recipient;
3. точно един tool call при успех;
4. правилно връщане към outer agent;
5. чист End Flow.

## 7. Практически шаблони за бъдещи задачи

### 7.1 Script tool → calling agent

```js
const callingAgentId = toolOptions.toolContext.agentId;
const callingSession = toolOptions.agentNode.flowContext.sessionId;

Agent.setRootAgentPrompt(callingAgentId, {
  prompt: `<TOOL_RESULT>\n${JSON.stringify(result)}\n</TOOL_RESULT>`,
  sessionID: callingSession,
  requestID: Tools.generateUUID()
});

return { done: true };
```

Path-ът до agent ID е проверен срещу engine source (2026-09-12): `toolOptions.agentNode` съдържа само `flowContext` + `nodeContext` — **няма** `agentId`; по-ранната версия `toolOptions.agentNode.agentId` е obsolete (връща `undefined` и `setRootAgentPrompt` хвърля TypeError → error edge, „No tool response"). Правилният е `toolOptions.toolContext.agentId`. Session pattern-ът е вече проверен.

### 7.2 Flow tool → nested agent → outer agent

Преди nested agent:

```js
dictionary.returnBridge = {
  mainAgentId: /* outer agent ID */,
  mainSession: toolOptions.agentNode.flowContext.sessionId
};
```

След nested agent:

```js
const response = Agent.getAgentLastResponse('nested-agent-id').response;
const bridge = dictionary.returnBridge;

Agent.setRootAgentPrompt(bridge.mainAgentId, {
  prompt: `<FLOW_TOOL_RESULT>\n${response}\n</FLOW_TOOL_RESULT>`,
  sessionID: bridge.mainSession,
  requestID: Tools.generateUUID()
});
```

Не разчитай само на outer `toolOptions` в return script-а (виж корекцията в 5.5): мостът в dictionary покрива Run Flow / Parallel под-flow и custom client без re-seed.

### 7.3 Self-correcting validation

При невалиден context tool-ът не трябва тихо да се проваля. Той трябва да изпрати към calling agent ясен резултат от вида:

```text
Контекстът е невалиден. Извикай tool-а отново точно с:
{"requiredField":"value"}
```

Prompt-ът трябва да различава success tag от validation/error tag, за да знае дали да повтори или да композира отговор.

## 8. Грешки, които да не се повтарят

- Да се приема, че JS `return` автоматично е tool response към LLM.
- Да се push-ва без `sessionID` и `requestID`.
- Да се използва bare `flowContext` вътре в script tool, когато резултатът трябва да стигне до calling agent.
- Да се разчита само на outer `toolOptions` без dictionary мост (в Run Flow / Parallel под-flow вътре в tool-а pack-ът липсва; custom client може да не го re-seed-ва).
- Да се проверява само HTTP status, без response schema.
- Да се допуска агентът да извика същия tool повторно след success marker.
- Да се променя `keen-tools.json` без redeploy.
- Да се тества в стар chat със замърсен session state.
- Да се копира deployment token в бележки или Git.
- Да се презаписват файлове на потребителя без проверка на текущото им състояние.
- Да се приема, че старата документация още е валидна след update.

## 9. Начален checklist за следваща Codex сесия

Преди работа:

- [ ] Прочети целия този файл.
- [ ] Прочети актуалните релевантни части от `shira-flow-builder-guide`.
- [ ] Прочети актуалните релевантни части от `keen-admin-guide`.
- [ ] Ако задачата засяга weather/country patterns, прочети съответния README в `shira-flow-builder-notes`.
- [ ] Провери `/home/n-ministation/Desktop/Building/src` и Git status, ако има repo.
- [ ] Не променяй unrelated user changes.
- [ ] Не показвай съдържание на `.vscode/keen.json`.

При implementation:

- [ ] Определи кой агент е caller и коя точно е неговата session.
- [ ] Генерирай нов `requestID` за всеки push.
- [ ] Валидирай context JSON self-correcting.
- [ ] Използвай success/error markers.
- [ ] Избягвай repeat loop след success.
- [ ] Capture-ни outer identity преди nested agent boundary.
- [ ] Ограждай HTTP/runtime interaction с `try/catch`.

При проверка:

- [ ] Провери JS syntax.
- [ ] Провери registry JSON.
- [ ] Redeploy при registry/flow промяна.
- [ ] Тествай в нов chat.
- [ ] Проследи node path в debugger-а.
- [ ] Провери логовете (live log stream) на платформата.
- [ ] Увери се, че main agent получава резултата само веднъж.
- [ ] Допълни history и направи локален commit.

## 10. Политика за тази памет

Този файл е дългосрочен handoff, не заместител на актуалната документация. Редът на доверие е:

1. текущо runtime поведение и debugger evidence;
2. най-новата локална документация;
3. task-specific бележките;
4. този обобщен history файл;
5. непроверени предположения.

При противоречие трябва да се запише какво е променено, а старото знание да се обозначи като obsolete, вместо тихо да се изтрие.

Не се записват тайни. Ако бъде използван credential по време на deploy, в history се записва само, че deploy-ът е успешен и по какъв общ механизъм, без самата стойност.

AI паметта между отделни чатове не е автоматична. Постоянството идва от този repo: новата сесия трябва изрично да прочете файла. Затова README съдържа bootstrap инструкция.

## 11. Хронология

### 2026-08-29 — документация и първи flow concepts

- Прочетени са `keen-admin-guide` и `shira-flow-builder-guide`, включително последващите им updates.
- Обяснени са Start Flow, Start Node, agent fields и `.flow` структурата.
- Изяснено е, че tools могат да бъдат script tools и flow tools.

### 2026-08-29 — Current Weather

- Изграден е обикновен weather script tool за `agent-one`.
- Диагностициран е погрешно изглеждащият „липсва token“ симптом.
- Намерен е липсващият session contract при `Agent.setRootAgentPrompt`.
- Потвърдено е, че script може да говори обратно на агента.
- Записани са отделни подробни бележки.

### 2026-08-29 — Country Info

- Изграден е flow tool с вложен `country-agent`.
- Изграден е `Country Lookup` script tool.
- Решен е nested return bridge чрез early capture на main agent identity в dictionary.
- Добавен е fallback за deprecated REST Countries v3.1 endpoint.
- Flow-ът е redeploy-нат и проверен с runtime logs и debugger.
- Потребителят потвърди, че системата и flow-ът работят.
- Записани са отделни подробни бележки.

### 2026-08-29 — persistent history repo

- Създаден е този `SESSION_HISTORY.md`.
- Създаден е README с bootstrap правила.
- Подготвено е локално Git repo, така че следващите открития да имат version history.

### 2026-09-12 — корекции след engine audit (без нова задача)

- §3.2: формата `!*action: use tool` (двоеточие) е obsolete — parser-ът приема само ключ на свой ред, стойност на следващия.
- §3.2: `!*context` е свободен текст за engine-а; JSON е проектна конвенция.
- §5.5 / §7.2 / §8: `toolOptions` **оцелява** вложения loop при референтните клиенти (client re-seed от `flow.options`); липсва само в Run Flow / Parallel под-flow вътре в tool-а и при custom client. Мостът в dictionary остава като защитен модел.
- §7.1: `toolOptions.agentNode.agentId` не съществува; правилно е `toolOptions.toolContext.agentId`.
- Няма промяна в работещия код на проектите; корекциите са в бележките и в `shira-flow-builder-guide` (tool-calling / building-tools / creating-tools / business-objects).

