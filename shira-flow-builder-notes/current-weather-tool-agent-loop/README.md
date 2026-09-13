# Current Weather tool и Agent tool loop — discoveries и runbook

Дата: 28–29 август 2026 г.  
Проект: /home/n-ministation/Desktop/Building  
Документация: /home/n-ministation/Desktop/shira-flow-builder-guide

## 1. Резюме

Задачата беше да се добави прост weather tool към съществуващ Keen/Shira агент.

Крайният дизайн е:

1. AgentOne разпознава заявка за текущо време.
2. Агентът излъчва SYSTEM CALL към Current Weather.
3. Script tool-ът приема JSON контекст с град.
4. Tool-ът намира координати чрез Open-Meteo Geocoding API.
5. Tool-ът взема текущите метеорологични условия чрез Open-Meteo Forecast API.
6. Tool-ът записва резултата като нов user-role prompt към същия агент.
7. AgentOne се стартира повторно, вижда WEATHER_RESULT и отговаря нормално на потребителя.

Най-важното discovery беше, че само Agent.setRootAgentPrompt(agentId, { prompt }) не е достатъчно за script tool. Отговорът трябва да е маркиран със session-а на извикалия Agent node и с нов request ID.

## 2. Файлове, които участват

В проекта бяха променени следните файлове:

- /home/n-ministation/Desktop/Building/src/keen-tools.json
- /home/n-ministation/Desktop/Building/src/scripts/tools/weather.js
- /home/n-ministation/Desktop/Building/src/flows/Project111.flow

Съществуващият flow е:

~~~text
Start → Script(init.js) → LLM(agent-one) → End
~~~

Не е необходим допълнителен Script node на canvas-а за weather tool-а. Script tool-ът се стартира виртуално от tool registry-то, когато engine-ът разпознае SYSTEM CALL.

## 3. Как работи tool registry

Tool-ът е регистриран в src/keen-tools.json:

~~~json
{
  "tools": [
    {
      "name": "Current Weather",
      "type": "script",
      "entry": "tools/weather.js"
    }
  ]
}
~~~

Правила:

- name трябва да съвпада точно с !*tool в SYSTEM CALL.
- type: script казва на engine-а да изпълни JavaScript tool.
- entry е спрямо src/scripts/.
- Script tool entry задължително трябва да започва с tools/.
- Реалният файл трябва да е в src/scripts/tools/.
- Промяна в keen-tools.json изисква нов deploy, защото registry-то се компилира в deployed flows/init.map.js.

## 4. Как агентът извиква tool-а

System prompt-ът на agent-one учи модела да излъчва:

~~~text
<SYSTEM CALL>
!*action
use tool
!*tool
Current Weather
!*context
{"city":"Bucharest"}
</SYSTEM CALL>
~~~

Използван е JSON контекст, защото:

- форматът се валидира лесно;
- tool-ът може да върне точна корекция;
- моделът може сам да повтори call-а при невалиден вход;
- по-късно могат да се добавят полета като language, units или days.

Tool-ът очаква:

~~~json
{"city":"Sofia"}
~~~

Ако JSON-ът е невалиден или city липсва, tool-ът връща self-correcting съобщение към агента с точния очакван формат.

## 5. Какво получава script tool-ът

При tool run има bare global toolOptions.

Нужните полета са:

| Поле | Значение |
|---|---|
| toolOptions.toolContext.options.context | Текстът от !*context |
| toolOptions.toolContext.agentId | Agent ID, към който трябва да се върне резултатът |
| toolOptions.toolContext.prompt | Пълният model response, съдържащ SYSTEM CALL |
| toolOptions.agentNode.flowContext.sessionId | Session ID на извикалия Agent node |

Критично уточнение:

- Bare global flowContext принадлежи на самия tool run.
- Script tool-ът получава собствен нов session/request context.
- За отговора не трябва да се използва flowContext.sessionId.
- Трябва да се използва toolOptions.agentNode.flowContext.sessionId.

## 6. Правилният contract за връщане на резултат

Script return value не се подава директно обратно към LLM.

Това не е достатъчно:

~~~js
return { result: weather };
~~~

Tool-ът трябва да запише нов user-role prompt към извикалия агент:

~~~js
import Agent from 'system/agent';
import Tools from 'system/tools';

const sendResult = (agentId, agentSessionId, result) => {
  Agent.setRootAgentPrompt(agentId, {
    prompt: '<WEATHER_RESULT>\n' +
      JSON.stringify(result) +
      '\n</WEATHER_RESULT>',
    sessionID: agentSessionId,
    requestID: Tools.generateUUID()
  });

  return { done: true };
};
~~~

Извличането на правилния session е:

~~~js
const tc = toolOptions.toolContext;
const agentId = tc.agentId;
const agentSessionId =
  toolOptions.agentNode.flowContext.sessionId;
~~~

Всеки success и error path трябва да използва един и същ helper:

~~~js
return sendResult(agentId, agentSessionId, result);
~~~

Защо са нужни полетата:

- sessionID свързва новия prompt със session-а на Agent node.
- requestID трябва да е нов, за да бъде prompt-ът разпознат като по-нов turn.
- Tools.generateUUID() е разрешеният UUID механизъм в script sandbox-а.
- Без правилния sessionID prompt-ът може да бъде записан, но остава невидим за повторно стартирания агент.
- Тогава engine-ът генерира synthetic user turn: No tool response.

Имената са case-sensitive:

- sessionID, не sessionId
- requestID, не requestId

## 7. Как се прояви проблемът

Потребителят написа:

~~~text
tell me what is the weather in Bucharest
~~~

UI правилно показа tool call:

~~~text
Current Weather
use tool
{"city":"Bucharest"}
~~~

Агентът опита tool-а два пъти, но после отговори, че weather data не е пристигнала.

Първоначалната хипотеза беше, че външният weather API иска token. Това беше погрешно.

Open-Meteo endpoint-ите, които използваме, не изискват API token за този случай. По-важното: runtime логовете показаха, че tool-ът реално се стартира и приключва успешно.

## 8. Как беше диагностицирано

### 8.1 Логове от script run-а

В логовете (live log stream) на платформата се виждаше:

~~~text
scriptName=tools/weather.js
run: tools/weather.js completed
committed dict + session
emitting final-flow signal (virtualScriptNode)
~~~

Това доказа:

- registry-то е правилно;
- tool path-ът е правилен;
- deployed project съдържа един tool;
- JavaScript-ът се компилира;
- script run-ът приключва cleanly;
- проблемът не е липсващ tool;
- проблемът не е обикновен uncaught exception.

### 8.2 Логове от agent handoff-а

В логовете (live log stream) на платформата се виждаше:

~~~text
tool did not push a prompt
recalling agentNode with 'No tool response' user turn
~~~

Това локализира проблема в conversation handoff-а между tool-а и повторно стартирания Agent node.

### 8.3 Извод

Tool-ът е извикал Agent.setRootAgentPrompt, но prompt-ът не е бил stamped с session-а на извикалия Agent node.

LLM engine проверява за по-нов user-role agentChat prompt, видим в session-а на Agent node. Prompt без правилния sessionID не покрива тази проверка.

## 9. Окончателната поправка

Към weather.js бяха добавени:

~~~js
import Tools from 'system/tools';
~~~

След това response helper-ът беше променен да приема agentSessionId:

~~~js
const sendResult = (agentId, agentSessionId, result) => {
  Agent.setRootAgentPrompt(agentId, {
    prompt: '<WEATHER_RESULT>\n' +
      JSON.stringify(result) +
      '\n</WEATHER_RESULT>',
    sessionID: agentSessionId,
    requestID: Tools.generateUUID()
  });

  return { done: true };
};
~~~

В exec се взема session-ът на Agent node:

~~~js
const agentSessionId =
  toolOptions.agentNode.flowContext.sessionId;
~~~

Всички седем success/error изхода бяха променени да използват:

~~~js
sendResult(agentId, agentSessionId, ...)
~~~

JavaScript синтаксисът беше проверен с:

~~~bash
node --check src/scripts/tools/weather.js
~~~

## 10. Weather API логика

Tool-ът използва два последователни HTTP request-а.

### 10.1 Geocoding

Вход:

~~~json
{"city":"Bucharest"}
~~~

Първо се извиква Open-Meteo Geocoding API, за да се намерят:

- latitude
- longitude
- canonical place name
- administrative region
- country

### 10.2 Current forecast

След това координатите се подават на Open-Meteo Forecast API.

Заявяват се текущи стойности за:

- temperature_2m
- apparent_temperature
- relative_humidity_2m
- precipitation
- weather_code
- wind_speed_10m
- timezone=auto

Weather code се превежда до четимо описание чрез локална WEATHER_CODES таблица.

## 11. system/http правила

В Shira script sandbox няма обикновен fetch. Външните заявки се правят чрез:

~~~js
import Http from 'system/http';
~~~

Използваният метод е:

~~~js
await Http.getJson(url)
~~~

Резултатът е:

~~~js
{
  ok,
  status,
  body
}
~~~

Два различни failure mode-а:

1. HTTP статус като 404 или 500:
   - не хвърля;
   - връща ok: false;
   - трябва изрично да се провери r.ok.

2. Transport, timeout, SSRF policy или buffer грешка:
   - хвърля exception;
   - трябва try/catch.

HTTP операциите трябва да са последователни.

Не трябва:

~~~js
await Promise.all([
  Http.getJson(urlA),
  Http.getJson(urlB)
]);
~~~

system/http и system/agent reads споделят ограничен buffer. Паралелни buffer операции могат да причинят E_SAB_BUSY.

## 12. Clean return и queued agent writes

Agent.setRootAgentPrompt queue-ва agent write вътре в isolate-а.

Записът се flush-ва след clean return.

Следователно:

- tool-ът трябва да върне cloneable plain object;
- HTTP грешките трябва да се прихващат;
- error result също трябва да се push-не към агента;
- след push трябва да има clean return;
- uncaught throw може да отмени queued agent writes.

Използваният завършек е:

~~~js
return { done: true };
~~~

Този return не е weather result за LLM. Той само приключва script run-а чисто. Реалният LLM result пътува през Agent.setRootAgentPrompt.

## 13. Self-correcting tool pattern

При невалиден context tool-ът не трябва просто да хвърли exception.

По-добър резултат е:

~~~json
{
  "ok": false,
  "retryable": true,
  "error": "Current Weather input is invalid.",
  "correction": "Call again with context as JSON: {\"city\":\"Sofia\"}."
}
~~~

Agent prompt-ът казва:

- при retryable: true да поправи SYSTEM CALL;
- да повтори максимум веднъж;
- ако потребителят не е дал град, да поиска уточнение;
- да не показва raw WEATHER_RESULT или internal protocol.

Това позволява tool loop-ът да се самокоригира без Error/Fallback edge.

## 14. Agent prompt правила

System prompt-ът трябва да съдържа едновременно:

1. Точния SYSTEM CALL формат.
2. Tool catalogue.
3. Точното име Current Weather.
4. JSON schema за context.
5. Инструкция как да обработи WEATHER_RESULT.
6. Инструкция да не извиква tool-а отново след ok: true.
7. Максимум един SYSTEM CALL block на turn.

Самият engine:

- не генерира tool catalogue;
- не обяснява tool-а на модела;
- изпълнява само първия SYSTEM CALL block;
- route-ва по !*tool name;
- не route-ва по !*action.

!*action е informational. type в keen-tools.json решава дали tool-ът е script или flow.

## 15. Deploy и cache

Локална промяна не означава автоматично, че runtime вече я използва.

Пътят е:

~~~text
Connect → Upload Project
~~~

Важни факти:

- При deploy целият src/ tree се качва.
- Server scan валидира flow-ове, scripts и registry.
- keen-tools.json се компилира в runtime registry.
- След успешен upload engine cache-ът се swap-ва.
- След първия upload auto-sync може да качва при save, но само ако extension window-ът остава connected.
- Ако auto-sync не е активен, трябва ръчен Upload Project.
- След промяна в tool response contract е добре тестът да започне в нов чат, за да няма стари No tool response turns в текущия transcript.

Runtime потвърждение:

~~~text
Loaded project ... 1 tool(s)
Cache swapped for project ...
~~~

## 16. Проверки, които бяха направени

### JSON

~~~bash
jq empty src/keen-tools.json src/flows/Project111.flow
~~~

### JavaScript

~~~bash
node --check src/scripts/tools/weather.js
~~~

### Wiring между файловете

Проверени бяха:

- registry name: Current Weather
- registry entry: tools/weather.js
- System prompt tool name: Current Weather
- context JSON format
- Agent ID: agent-one
- Start Flow: Project111
- Start Node: Start
- specialRules не съдържа skip-internal-tooling

### Runtime

Проверени бяха логовете (live log stream) на платформата — без достъп до сървъра.

Deployment token не беше отпечатван. При диагностика от keen.json бяха четени само server и space.

## 17. Symptom → вероятна причина

| Симптом | Вероятна причина |
|---|---|
| Агентът показва raw текст вместо да пусне tool | Use tools е изключено или SYSTEM CALL markers са грешни |
| The requested tool does not exist | name не съвпада или project registry не е redeploy-нат |
| No tool response, а script не се стартира | грешен entry path или невалиден script tool path |
| Script се стартира и завършва, но пак No tool response | липсва/е грешен sessionID или няма нов requestID |
| Agent се върти и вика tool-а пак | prompt-ът не му казва да спре след успешен WEATHER_RESULT |
| Error edge / child flow спира | uncaught exception или forbidden import |
| HTTP 4xx/5xx | провери r.ok и r.status |
| Timeout/SSRF/E_SAB error | try/catch и sequential HTTP operations |
| Локално е поправено, runtime е стар | Connect + Upload Project / липсва auto-sync |
| Tool се намира, но API резултатът липсва | провери логовете на платформата и response payload преди да обвиняваш API token |

## 18. Checklist за всеки бъдещ script tool

### Registry

- [ ] Файлът е под src/scripts/tools/.
- [ ] entry започва с tools/.
- [ ] name съвпада точно с !*tool.
- [ ] keen-tools.json е валиден JSON.
- [ ] Project-ът е redeploy-нат.

### Agent prompt

- [ ] Има пълен SYSTEM CALL template.
- [ ] Има tool catalogue.
- [ ] Context schema е точна.
- [ ] Моделът излъчва един call наведнъж.
- [ ] Указано е как да разпознае tool result.
- [ ] Указано е кога да не повтаря call-а.

### Script

- [ ] Има named export exec.
- [ ] Използва само system/* и relative imports.
- [ ] Валидира context.
- [ ] HTTP status се проверява чрез ok.
- [ ] Transport errors са в try/catch.
- [ ] Няма паралелни system/http/system/agent reads.
- [ ] Взема agentId от toolOptions.toolContext.agentId.
- [ ] Взема agent session от toolOptions.agentNode.flowContext.sessionId.
- [ ] Не използва tool flowContext.sessionId за reply.
- [ ] Всеки reply има sessionID.
- [ ] Всеки reply има fresh requestID.
- [ ] Всеки success/error path push-ва prompt.
- [ ] Script-ът завършва с clean cloneable return.

### Verification

- [ ] node --check минава.
- [ ] JSON validation минава.
- [ ] Upload Project е успешен.
- [ ] Engine cache е swap-нат.
- [ ] Тестът е в нов chat turn.
- [ ] При проблем се проверяват логовете (live log stream) на платформата.

## 19. Документационни discoveries

По време на задачата shira-flow-builder-guide беше обновяван няколко пъти.

Първоначалната документация правилно казваше да се използва Agent.setRootAgentPrompt, но не уточняваше задължителния session stamp.

Критичното ново уточнение се появи в tool-calling.md:

- toolOptions.agentNode.flowContext.sessionId е session-ът на извикалия agent;
- reply трябва да включва sessionID;
- reply трябва да получи fresh requestID чрез Tools.generateUUID();
- bare flowContext на script tool-а е различен и не трябва да се използва за тази цел.

Важно: worked snippets в други документи могат временно да изостават и да показват само { prompt }. При конфликт за tool response contract трябва да се следва най-новата engine-verified секция в tool-calling.md.

## 20. Най-кратката формула

За script tool, който връща резултат към агент:

~~~js
import Agent from 'system/agent';
import Tools from 'system/tools';

export const exec = async () => {
  const tc = toolOptions.toolContext;
  const agentSessionId =
    toolOptions.agentNode.flowContext.sessionId;

  const result = {
    ok: true,
    data: 'example'
  };

  Agent.setRootAgentPrompt(tc.agentId, {
    prompt: JSON.stringify(result),
    sessionID: agentSessionId,
    requestID: Tools.generateUUID()
  });

  return { done: true };
};
~~~

Това е canonical pattern-ът, който трябва да се използва занапред.
