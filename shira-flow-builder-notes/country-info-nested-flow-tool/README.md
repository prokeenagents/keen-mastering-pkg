# Country Info: flow tool с вложен агент и надежден return bridge

Дата: 2026-08-29

Проект:

- `<project-root>`
- source root: `<project-root>/src`
- Space / project id: `<space-id>`

## 1. Каква беше задачата

Да се направи не обикновен script tool, а **flow tool**, който съдържа втори агент и втори tool loop:

```text
потребител
  ↓
AgentOne (agent-one)
  ↓ SYSTEM CALL: Country Info
CountryInfo.flow
  ↓
CountryAgent (country-agent)
  ↓ SYSTEM CALL: Country Lookup
countryLookup.js
  ↓ REST Countries data
CountryAgent
  ↓ приятно текстово описание
returnToMain.js
  ↓
AgentOne
  ↓ финален отговор на езика на потребителя
```

Това упражнява две вложени tool извиквания:

1. `agent-one` извиква flow tool-а `Country Info`.
2. `country-agent` вътре във flow tool-а извиква script tool-а `Country Lookup`.

## 2. Крайният резултат

Реализирани и регистрирани са три tools общо:

```json
{
  "tools": [
    {
      "name": "Current Weather",
      "type": "script",
      "entry": "tools/weather.js"
    },
    {
      "name": "Country Info",
      "type": "flow",
      "entry": "CountryInfo-Start"
    },
    {
      "name": "Country Lookup",
      "type": "script",
      "entry": "tools/countryLookup.js"
    }
  ]
}
```

Тестът в нов чат мина успешно. Потребителят потвърди, че крайният агент връща описанието.

Финалният успешен runtime trace няма `No tool response` между:

- първото изпълнение на `CountryAgent`;
- `Country Lookup`;
- второто изпълнение на `CountryAgent`;
- `returnToMain.js`;
- повторното изпълнение на `AgentOne`.

## 3. Създадени и променени файлове

### Нов flow

- `src/flows/CountryInfo.flow`

### Нови scripts

- `src/scripts/countryInfo/setup.js`
- `src/scripts/countryInfo/returnToMain.js`
- `src/scripts/tools/countryLookup.js`

### Променени файлове

- `src/keen-tools.json`
- `src/flows/Project.flow`

`Project.flow` остана главният flow. Неговият `AgentOne` system prompt беше допълнен с публичния tool `Country Info`.

`Country Lookup` не е описан на главния агент. Той е вътрешен tool, преподаван само на `country-agent`.

## 4. Структура на CountryInfo.flow

Крайният graph е:

```text
Start
  ↓
Script: countryInfo/setup.js
  ↓
Condition: ${dictionary.countryInfoReady} === true
  ├─ false → End
  └─ true
       ↓
     Agent: country-agent
       ↓
     Script: countryInfo/returnToMain.js
       ↓
     End
```

Condition node-ът използва правилната placeholder форма:

```text
${dictionary.countryInfoReady} === true
```

Не трябва да се използва:

```text
dictionary.countryInfoReady === true
```

Bare member access се отхвърля от condition evaluator-а.

False branch-ът съществува за self-correcting validation. При невалиден outer context setup script-ът връща корекция директно на `AgentOne`, после приключва flow tool-а без да стартира вложения агент.

## 5. Най-важното откритие: return bridge-ът

### Проблемът

Когато `AgentOne` извика `Country Info`, първите nodes на flow tool-а получават outer tool pack:

```text
toolOptions = {
  toolContext: { ... caller = agent-one ... },
  agentNode: { ... AgentOne session ... }
}
```

Но `country-agent` после започва собствен tool loop и извиква `Country Lookup`.

При приключване на вътрешния script tool engine-ът redispatch-ва `country-agent` с:

```js
options: {
  toolResponse: true,
  promptMarker
}
```

Това вече не е outer `{toolContext, agentNode}` pack-ът на `AgentOne` — но той стига **само до самия Agent node** (LLM node), не до script node-овете.

След финалния plain-text отговор на `country-agent`, engine-ът създава next-node task към `returnToMain.js` без options — а референтният клиент (test harness / entanglement / agent-runner) seed-ва всеки nodeTask на `toolFlow` bundle, който няма свои options, от `flow.options`. Тоест `returnToMain.js` реално получава outer pack-а на `AgentOne`.

> Корекция (2026-09-12, проверено срещу engine + client source): по-ранната версия на тази бележка
> заключаваше, че pack-ът е „ненадежден" след вложения агент. Това е obsolete. Pack-ът **липсва** само в
> Run Flow / Parallel под-flow, spawn-нат отвътре на tool-а (spawn-натите bundles не наследяват options),
> и при custom client без re-seed. Мостът в dictionary остава правилният **защитен** модел за тези случаи.

Следователно return script-ът не бива да разчита **само** на:

```js
// Работи с референтните клиенти, но не и в Run Flow под-flow / custom client без re-seed:
const mainAgentId = toolOptions.toolContext.agentId;
const mainSession = toolOptions.agentNode.flowContext.sessionId;
```

### Решението

Outer agent identity се улавя в първия Script node, преди да стартира `country-agent`:

```js
dictionary.countryInfoBridge = {
    mainAgentId: toolOptions.toolContext.agentId,
    mainSession: toolOptions.agentNode.flowContext.sessionId
};
```

После return script-ът чете само dictionary bridge-а:

```js
const bridge = dictionary.countryInfoBridge;
const mainAgentId = bridge.mainAgentId;
const mainSession = bridge.mainSession;
```

Той нарочно не чете `toolOptions`.

### Защо dictionary, а не return value

Return value от Script node не се подава автоматично на следващия агент и не е tool response към LLM.

Dictionary:

- се commit-ва при clean return на `setup.js`;
- остава достъпен в същия `CountryInfo` flow;
- преживява tool loop-а на вложения агент;
- е подходящ за малкия bridge object.

### Какво показаха source code и runtime логовете за toolOptions

Обикновените логове на платформата не dump-ват целия `payload.options`, затова не трябва да се твърди, че логът е отпечатал самия object.

Точната промяна беше потвърдена от engine source-а:

- flow-tool start получава `options:{toolContext,agentNode}`;
- engine-ът auto-propagates inbound options само по continuation nodes в същия flow (не и към spawn-нати childFlows / parallelContext bundles);
- inner tool redispatch от engine-а носи само `options:{toolResponse,promptMarker}` — и то само към самия Agent node;
- финалният text continuation на Agent node се emit-ва без outer options;
- **но** клиентският SDK (`task-queue.ts`, правилото „explicit `node.options` печели; иначе за всеки nodeTask в `toolFlow:true` bundle seed от `flow.options`") връща outer pack-а върху този continuation — затова `returnToMain.js` го вижда.

Runtime логовете потвърдиха границите на тези изпълнения:

- `setup.js` работи в `CountryInfo` flow/session;
- `countryLookup.js` работи като отделен `virtualScriptNode` с нов flow/session;
- `returnToMain.js` отново работи в оригиналния `CountryInfo` flow/session;
- return script-ът успява чрез dictionary bridge-а;
- веднага след него `AgentOne` се изпълнява отново и дава финалния отговор.

За директно визуално виждане на bare global-а може да се сложи breakpoint и да се гледа `global.toolOptions` в debugger-а. Работещият код не зависи от това дали pack-ът е налице или липсва (Run Flow под-flow, custom client) — return bridge-ът е устойчив и в двата случая.

## 6. Трите различни session-а

Това е най-важната session карта за вложени tools.

| Session | На кого принадлежи | Откъде се взема | За какво се използва |
|---|---|---|---|
| Main session | `AgentOne` | `toolOptions.agentNode.flowContext.sessionId` в `setup.js` | Финалният отговор обратно към главния агент |
| CountryInfo flow session | flow tool-ът и `country-agent` | bare `flowContext.sessionId` в `setup.js` | Trigger prompt към вложения агент |
| Country Lookup tool session | виртуалният script-tool child flow | bare `flowContext.sessionId` вътре в `countryLookup.js` | Това е собствената session на tool-а; не се използва за reply към агента |

### Критичният вътрешен reply contract

`Country Lookup` отговаря на `country-agent`, затова трябва да използва:

```js
const agentSession = toolOptions.agentNode.flowContext.sessionId;

Agent.setRootAgentPrompt(agentId, {
    prompt,
    sessionID: agentSession,
    requestID: Tools.generateUUID()
});
```

Не трябва да използва bare `flowContext.sessionId`, защото това е session-ът на виртуалния script tool, не session-ът на `country-agent`.

### Outer return contract

`returnToMain.js` отговаря на `AgentOne` със session-а, запазен в dictionary:

```js
Agent.setRootAgentPrompt(mainAgentId, {
    prompt,
    sessionID: mainSession,
    requestID: Tools.generateUUID()
});
```

И на двете нива важат едни и същи правила:

- точният calling-agent `sessionID`;
- нов `requestID`;
- `Agent.setRootAgentPrompt`;
- clean return след queued agent write.

## 7. Setup script-ът

`setup.js` извършва четири действия в правилния ред.

### 7.1 Улавя outer identity

```js
mainAgentId = toolOptions.toolContext.agentId;
mainSession = toolOptions.agentNode.flowContext.sessionId;
```

### 7.2 Записва return bridge

```js
dictionary.countryInfoBridge = {
    mainAgentId,
    mainSession
};
```

### 7.3 Валидира outer context

Очакваната форма е:

```json
{"country":"Bulgaria"}
```

При невалиден JSON или празен `country` script-ът изпраща:

```text
<COUNTRY_INFO_RESULT>
{"ok":false,"retryable":true,...}
</COUNTRY_INFO_RESULT>
```

на `AgentOne`, маркира `dictionary.countryInfoReady = false` и приключва clean.

### 7.4 Seed-ва вложения агент

Един Agent node не получава input от graph edge-а като function argument. Той чете latest user-role agentChat prompt от своята conversation lane.

Затова setup script-ът трябва изрично да създаде trigger:

```js
Agent.setRootAgentPrompt('country-agent', {
    prompt: `<COUNTRY_INFO_REQUEST>\n${JSON.stringify({ country })}\n</COUNTRY_INFO_REQUEST>`,
    sessionID: flowContext.sessionId,
    requestID: Tools.generateUUID()
});
```

Без това вложеният агент няма live user trigger и може да стигне до `E6002`/липса на prompt.

## 8. CountryAgent

Вложеният агент има различен identity:

```text
agentId: country-agent
agentName: CountryAgent
```

Той не трябва да използва `agent-one`, защото prompt/response lanes ще се смесят.

System prompt-ът му преподава само:

- как да прочете `<COUNTRY_INFO_REQUEST>`;
- точния `<SYSTEM CALL>` grammar;
- tool name `Country Lookup`;
- context JSON `{"country":"Bulgaria"}`;
- как да обработи `<COUNTRY_LOOKUP_RESULT>`;
- да не показва raw JSON или internal protocol;
- при `ok:true` да не извиква tool-а отново;
- да направи 3–5 естествени изречения.

Включено е:

```json
{
  "type": "skip-internal-database-interactions"
}
```

Така `country-agent` е transient sub-agent. Runtime логовете потвърдиха:

```text
db persist skipped ... agentNode opted out via skip-internal-database-interactions
```

Това не пречи на `Agent.getAgentLastResponse`, защото отговорът продължава да се mirror-ва в agent state.

## 9. Country Lookup script tool

Tool-ът:

1. чете `toolOptions.toolContext.options.context`;
2. валидира `{"country":"..."}`;
3. прави sequential HTTP calls;
4. нормализира резултата;
5. push-ва `<COUNTRY_LOOKUP_RESULT>` към `country-agent`;
6. приключва clean.

Нормализираният payload съдържа:

- requested name;
- common name;
- emoji flag;
- first capital;
- population;
- region;
- subregion;
- currencies като `{code,name,symbol}`;
- languages като list;
- source.

### Name matching във fallback dataset-а

Търсенето проверява:

- `name.common`;
- `name.official`;
- `altSpellings`;
- native common/official names.

Първо се търси case-insensitive exact match. Partial match се приема само ако е уникален.

Това позволява например и native name като `България` да намери `Bulgaria`.

## 10. REST Countries промяната през 2026 г.

Първоначално задачата посочи:

```text
https://restcountries.com/v3.1/name/{name}?fields=name,capital,population,region,subregion,currencies,languages,flag
```

На 2026-08-29 live проверката показа:

1. endpoint-ът връща HTTP redirect;
2. след redirect връща HTTP 200, но body е deprecation error;
3. официалната документация вече сочи v5 с authentication.

Тоест HTTP `ok:true` само по себе си не означава валидни country data. Трябва да се провери и shape-ът на body.

Имплементацията запазва поискания endpoint като primary path:

```js
if (legacyResponse.ok && Array.isArray(legacyResponse.body)) {
    country = legacyResponse.body[0] ?? null;
}
```

Ако body не е array с country record, се използва безключов fallback към официалния open-source REST Countries v3.1 dataset:

```text
https://raw.githubusercontent.com/restcountries/restcountries/master/src/main/resources/countriesV3.1.json
```

Провереният файл беше:

- HTTP 200;
- 1,475,287 bytes;
- под общия ~10 MB system/http + agent-read buffer;
- съдържа очакваната v3.1 schema.

Това запази изискването да няма API key/token и използва официалния open-source dataset на REST Countries.

## 11. Return script-ът

Когато `country-agent` даде финален plain-text отговор, Agent node-ът излиза през `next_1` и едва тогава стартира return script-ът.

Отговорът се чете така:

```js
const nestedResponse = Agent.getAgentLastResponse('country-agent');
const description = nestedResponse?.response?.trim();
```

Това е важният conversation bridge: script може да чете отговор на агент и да говори обратно на друг агент.

После description се опакова в отделен protocol tag:

```text
<COUNTRY_INFO_RESULT>
{"ok":true,"country":"Bulgaria","description":"..."}
</COUNTRY_INFO_RESULT>
```

и се push-ва към `AgentOne` със запазената main session.

Главният агент вижда нов user-role turn, изпълнява се отново и прави финален отговор на езика на потребителя.

## 12. Двата agent prompt-а имат различни каталози

### AgentOne знае за

- `Current Weather`
- `Country Info`

### CountryAgent знае за

- `Country Lookup`

Това разделение е умишлено.

Tool registry-то е общо за проекта, но всеки агент трябва да бъде научен само за tool-овете, които е предвидено да извиква.

Engine-ът не генерира автоматично tool catalogue от `keen-tools.json`.

## 13. Self-correcting validation

И outer flow tool-ът, и inner script tool-ът връщат структурирана корекция вместо да throw-ват за лош model context.

Пример:

```json
{
  "ok": false,
  "retryable": true,
  "error": "Country Lookup input is invalid.",
  "correction": "Call Country Lookup again with !*context as valid JSON: {\"country\":\"Bulgaria\"}."
}
```

Prompt-ите ограничават retry до най-много веднъж.

Това предотвратява безкрайни loops.

## 14. Clean return и try/catch

Agent writes са queued в script isolate-а.

При clean return:

- queued `Agent.set...` writes се flush-ват;
- dictionary се commit-ва;
- session се commit-ва;
- flow-ът продължава.

При uncaught throw:

- dictionary changes се discard-ват;
- queued agent writes се discard-ват;
- error routing се активира.

Затова scripts използват `try/catch` и при очаквани failure cases:

- push-ват error result към съответния агент;
- връщат `{ok:false,...}` clean;
- не throw-ват след queued reply.

HTTP operations са sequential. Не се използва `Promise.all` около `system/http`.

## 15. Deploy открития

Промяна само в `keen-tools.json` не е достатъчна.

Runtime чете compiled registry:

```text
flows/init.map.js
```

Затова след registry промяна е задължителен redeploy.

Deploy-ът мина с:

```text
connect HTTP 200
upload HTTP 200
```

Платформата потвърди при deploy:

```text
scanned + promoted
```

Логовете на платформата потвърдиха:

```text
Loaded project ... 7 file(s), 14 node(s), 3 entries, 3 tool(s)
Cache swapped for project ...
```

Deployed `flows/init.map.js` съдържа:

- Current Weather;
- Country Info;
- Country Lookup.

Deployed `CountryInfo.flow.map.js` съдържа:

```js
"CountryInfo-Start": "startNode_<12-char-id>"
```

Това потвърждава, че flow tool entry-то се resolve-ва към реален Start node.

## 16. Реалната успешна runtime следа

Последният успешен trace използва един correlation id за целия run:

```text
<correlation-id>
```

Основните identities бяха шест различни id-та (стойностите не се пазят тук):

```text
AgentOne root flowId:
<root-flow-id>

AgentOne root sessionId:
r-<root-session-id>

CountryInfo flowId:
<country-info-flow-id>

CountryInfo / CountryAgent sessionId:
<country-info-session-id>

Country Lookup virtual tool flowId:
<lookup-tool-flow-id>

Country Lookup own tool sessionId:
<lookup-tool-session-id>
```

Важното е, че трите session id-та са различни — точно картата от §6.

Редът в логовете беше:

1. `AgentOne` започва в root flow.
2. `countryInfo/setup.js` започва в `CountryInfo` flow.
3. Setup завършва с committed dict/session.
4. `CountryAgent` се изпълнява за първи път.
5. `tools/countryLookup.js` се изпълнява в отделен virtual tool flow/session.
6. Lookup завършва с `final-flow signal (virtualScriptNode)`.
7. `CountryAgent` се изпълнява втори път и композира final text.
8. `countryInfo/returnToMain.js` се изпълнява отново в оригиналния CountryInfo flow/session.
9. Return завършва с committed dict/session.
10. `AgentOne` се изпълнява повторно в root flow.
11. Главният flow приключва нормално.

В този финален trace не се появи:

```text
tool did not push a prompt
```

между tool call-а и финалния отговор.

Това е runtime доказателството, че и двата reply bridge-а са получили правилните session IDs.

## 17. Наблюдавани, но несвързани warnings

В общите логове на платформата може да има и несвързани платформени warnings, които не са причина за Country Info поведението. Country Info trace-ът въпреки това завърши успешно.

Не трябва тези несвързани платформени warnings да се бъркат с tool error, освен ако конкретният run не спира на тях.

## 18. Какво да не се прави

### Не разчитай на Script return value като tool reply

```js
return { country: data };
```

само по себе си не говори на агента.

### Не използвай bare flowContext за reply от script tool

```js
sessionID: flowContext.sessionId
```

е грешно в `Country Lookup`, защото това е session-ът на tool child flow-а.

### Не разчитай само на toolOptions в return script след nested loop

С референтните клиенти outer pack-ът е налице (re-seed от `flow.options`), но в Run Flow / Parallel под-flow вътре в tool-а го няма, а custom client може да не го подава — чети моста от dictionary.

### Не забравяй да seed-неш вложения агент

Edge към Agent node не създава автоматично user prompt за различен agentId.

### Не използвай един и същ agentId за main и nested agent

Conversation state ще се смеси.

### Не преподавай вътрешния tool на грешния агент

Main агентът трябва да извиква `Country Info`, а nested агентът — `Country Lookup`.

### Не забравяй redeploy след keen-tools.json

Runtime registry-то е compiled artifact.

### Не приемай HTTP 200 като достатъчно

Deprecated REST Countries v3.1 връща error envelope с HTTP 200 след redirect. Проверявай response shape.

### Не оставяй uncaught throw след Agent.set...

Queued reply може да бъде discard-нат.

## 19. Универсален шаблон за бъдещ nested flow tool

```text
Main Agent
  ↓ calls Flow Tool
Start
  ↓
Setup Script
  - capture outer agentId
  - capture outer agent session
  - save bridge in dictionary
  - validate context
  - seed Inner Agent with flowContext.sessionId
  ↓
Inner Agent
  ↓ calls Inner Script Tool
Inner Script Tool
  - read toolOptions.toolContext
  - reply to Inner Agent with toolOptions.agentNode session
  ↓
Inner Agent final text
  ↓
Return Script
  - read Agent.getAgentLastResponse(innerId).response
  - read outer identity from dictionary
  - reply to Main Agent with saved main session
  ↓
End
```

Минималният bridge object е:

```js
dictionary.someToolBridge = {
    mainAgentId,
    mainSession
};
```

## 20. Финален checklist

- [x] Flow tool е регистриран с `type: "flow"`.
- [x] Entry е `CountryInfo-Start`.
- [x] Inner script tool е под `scripts/tools/`.
- [x] Script entry започва с `tools/`.
- [x] Main prompt знае `Country Info`.
- [x] Nested prompt знае `Country Lookup`.
- [x] Agent IDs са различни.
- [x] Outer identity се capture-ва преди nested agent-а.
- [x] Bridge-ът се пази в dictionary.
- [x] Inner agent е seed-нат с CountryInfo flow session.
- [x] Inner script tool отговаря с CountryAgent session.
- [x] Return script чете `.response` на `country-agent`.
- [x] Return script отговаря със запазената AgentOne session.
- [x] Всеки push има fresh requestID.
- [x] Context validation е self-correcting.
- [x] HTTP calls са sequential и в try/catch.
- [x] Scripts clean-return-ват след queued writes.
- [x] Registry е redeploy-нат.
- [x] Compiled registry и entry map са проверени.
- [x] Тестът е направен в нов чат.
- [x] Runtime trace показва пълния nested loop.
- [x] Потребителят потвърди успешен краен отговор.

## 21. Най-краткото правило за запомняне

При nested flow tool има два отделни reply моста:

```text
inner script tool → inner agent
```

използва текущия inner tool `toolOptions.agentNode.flowContext.sessionId`, а:

```text
flow tool return script → main agent
```

използва main agent identity/session, запазени в dictionary като защитен мост (вложеният tool loop не подменя `toolOptions` при референтните клиенти — вж. §5; мостът покрива Run Flow под-flow и custom client).

Това е централното решение на задачата.
