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

1. **Proxy**: *Administration → Proxies → Create proxy*
   - Name: `zabbix-proxy-otel` (igual a `ZBX_HOSTNAME` em `env/zabbix-proxy/proxy.env`)
   - Mode: **Active**
2. **Host da aplicação**: *Data collection → Hosts → Create host*
   - Monitored by: **Proxy** `zabbix-proxy-otel`
   - Template: **Generic OpenTelemetry by OTLP**
   - Ajuste as macros do template (por exemplo o nome do serviço: `zabbix-login-demo` para o app de exemplo).
3. **Host "Zabbix server"**: altere a interface do agent para o DNS `zabbix-agent` (conectar por DNS).

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
