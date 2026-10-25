# Laboratório Zabbix 8.0 + OpenTelemetry + MCP Server

Ambiente de **teste** do Zabbix 8.0 (imagens `trunk`, pois a 8.0 ainda não tem tag estável no Docker Hub) com:

| Serviço | Container | Porta no host | Função |
|---|---|---|---|
| `postgres` | zbx8-postgres | – | Banco de configuração/histórico do Zabbix |
| `clickhouse` | zbx8-clickhouse | 8123 | Armazena traces, logs e métricas OpenTelemetry |
| `zabbix-server` | zbx8-server | 10051 | Zabbix server |
| `zabbix-web` | zbx8-web | 8080 | Frontend (Admin / zabbix) |
| `zabbix-agent` | zbx8-agent | – | Agent 2 monitorando o próprio ambiente |
| `zabbix-proxy` | zbx8-proxy | 10061, 14317 | Proxy ativo com receptor **OTLP gRPC** nativo (APM collector) |
| `otel-collector` | zbx8-otel-collector | 4317 (gRPC), 4318 (HTTP) | Recebe OTLP das aplicações e repassa ao proxy |
| `zabbix-mcp-server` | zbx8-mcp-server | 8443 | Zabbix MCP server (`/mcp`) para agentes de IA |
| `demo-app` *(perfil `demo`)* | zbx8-demo-app | 3001 | App Node.js instrumentada com OpenTelemetry |

## Fluxo da telemetria

```
App (SDK OTel) ──OTLP──▶ otel-collector :4317/4318 ──OTLP gRPC──▶ zabbix-proxy :4317
                                                                     │
                                                                     ▼
                         Zabbix server / frontend ◀── consulta ── ClickHouse (otel_*)
```

O proxy grava os dados nas tabelas `otel_traces`, `otel_logs` e `otel_metrics_*` do ClickHouse, criadas
automaticamente na primeira subida por [`config/clickhouse/initdb.d/01_otel_schema.sql`](config/clickhouse/initdb.d/01_otel_schema.sql).
O server e o frontend consultam o mesmo ClickHouse (itens *Telemetry query* e telas de APM).

## Estrutura

```
zabbix8-lab/
├── docker-compose.yml
├── .env.example                 # tags das imagens, portas e diretório de dados
├── env/                         # variáveis de cada serviço, uma pasta por container
│   ├── common/telemetry.env     # provedor ClickHouse (server, proxy e frontend)
│   ├── postgres/postgres.env
│   ├── clickhouse/clickhouse.env
│   ├── zabbix-server/server.env
│   ├── zabbix-web/web.env
│   ├── zabbix-proxy/proxy.env
│   ├── zabbix-agent/agent.env
│   ├── mcp-server/mcp.env
│   └── demo-app/app.env
├── config/
│   ├── otel-collector/config.yaml
│   └── clickhouse/initdb.d/01_otel_schema.sql
└── apps/login-app/              # app de exemplo instrumentada (perfil demo)
```

> **ClickHouse 26.8 ou mais novo é obrigatório**: o proxy envia os timestamps como número com fração
> (`1792961467.316000000`), formato que o ClickHouse 25.8 rejeita com `ParsingError`.
>
> As senhas são padrões de laboratório (`zabbix`). Troque antes de expor o ambiente fora da sua máquina.
> Se mudar a senha do ClickHouse, altere em `env/clickhouse/clickhouse.env` **e** em `env/common/telemetry.env`.

## Subindo o ambiente

```sh
cd zabbix8-lab
cp .env.example .env
docker compose pull
docker compose up -d
```

Com a aplicação de exemplo gerando telemetria:

```sh
docker compose --profile demo up -d --build
```

Acesse o frontend em http://localhost:8080 (usuário `Admin`, senha `zabbix`).

## Configuração no frontend

O receptor OTLP do proxy **só abre a porta 4317** quando os dois itens abaixo estão habilitados.
Até lá, o collector registra `connection refused` ao tentar enviar dados ao proxy.

1. **Fonte de dados APM (global)**: *Administration → Data source → APM*
   - Status: configurado
   - URL: `http://clickhouse:8123`, Database: `zabbix`
   - Autenticação por senha: usuário `zabbix`, senha `zabbix` (valores de `env/clickhouse/clickhouse.env`)
2. **Proxy**: *Administration → Proxies → Create proxy*
   - Name: `zabbix-proxy-otel` (igual a `ZBX_HOSTNAME` em `env/zabbix-proxy/proxy.env`)
   - Mode: **Active**
   - Aba **APM** → marque **Data collection enabled**
   
   Em até ~1 minuto o log do proxy deve mostrar
   `[apm manager #1] Open Telemetry collector listening on 0.0.0.0:4317`.
3. **Host da aplicação**: *Data collection → Hosts → Create host*
   - Monitored by: **Proxy** `zabbix-proxy-otel`
   - Template: **Generic OpenTelemetry by OTLP**
   - Ajuste as macros do template (por exemplo o nome do serviço: `zabbix-login-demo` para o app de exemplo).
4. **Host "Zabbix server"**: altere a interface do agent para o DNS `zabbix-agent` (conectar por DNS).

<details>
<summary>Os passos 1 e 2 também podem ser feitos pela API</summary>

```sh
# settings.update: fonte de dados APM global (authentication_type 0 = senha)
{"jsonrpc":"2.0","method":"settings.update","id":1,"params":{"apm_global_db":{
  "status":1,"url":"http://clickhouse:8123","db":"zabbix",
  "authentication_type":0,"username":"zabbix","password":"zabbix"}}}

# proxy.create com coleta APM habilitada
{"jsonrpc":"2.0","method":"proxy.create","id":2,"params":{
  "name":"zabbix-proxy-otel","operating_mode":0,"apm":{"data_collection_status":1}}}
```
</details>

Para gerar tráfego no app de exemplo, acesse http://localhost:3001 e faça login/logout
(usuário e senha em `env/demo-app/app.env`).

### Enviando telemetria das suas próprias aplicações

- Via collector: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317` (gRPC) ou `http://localhost:4318` (HTTP).
- Direto no proxy (somente gRPC): `http://localhost:14317`.

## MCP Server

1. No frontend, crie um token de API: *User settings → API tokens → Create API token*.
2. Teste o endpoint:

```sh
export ZABBIX_API_TOKEN=<seu token>
curl -sS http://localhost:8443/mcp \
  -H "Authorization: Bearer $ZABBIX_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

3. Para usar no Claude Code:

```sh
claude mcp add --transport http zabbix http://localhost:8443/mcp \
  --header "Authorization: Bearer $ZABBIX_API_TOKEN"
```

O MCP server não guarda credenciais: cada requisição usa o token do usuário, então o agente só vê e altera
o que esse usuário pode. Por padrão as ferramentas `problem_*` e `maintenance_*` (escrita) estão habilitadas;
regras de acesso (`ZBX_ALLOWTOOL_*` / `ZBX_DENYTOOL_*`) podem ser adicionadas em `env/mcp-server/mcp.env`.

## Verificações úteis

```sh
# Logs do receptor OTLP do proxy
docker compose logs -f zabbix-proxy

# O collector está recebendo/enviando?
docker compose logs -f otel-collector

# Dados chegando no ClickHouse
docker compose exec clickhouse clickhouse-client -u zabbix --password zabbix \
  -q "SELECT ServiceName, count() FROM zabbix.otel_traces GROUP BY ServiceName"
```

## Limpeza

```sh
docker compose --profile demo down
rm -rf data/      # apaga os dados persistidos
```
