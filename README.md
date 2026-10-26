# Zabbix

Laboratório de observabilidade com Zabbix: stack em Docker (Zabbix Server, Frontend,
Agent 2, PostgreSQL, ClickHouse e Grafana), demonstração de APM com OpenTelemetry
e templates do Zabbix.

O repositório é **genérico por design**: nada específico de um ambiente fica no código.
Tudo que muda entre DEV e PROD é variável de ambiente (Docker) ou macro de usuário
(templates do Zabbix). Assim, o mesmo código roda no laboratório e no ambiente
corporativo, mudando apenas o arquivo de variáveis.

## Estrutura

```
config/
  dev.env.example     # variáveis do laboratório (copiar para dev.env)
  prod.env.example    # apenas os nomes das variáveis de produção
Docker/
  docker-compose.yml      # stack principal (core)
  docker-compose-app.yml  # demonstração APM com OpenTelemetry (app)
  otel-collector.yaml
  login-app/              # aplicação de login instrumentada
  zabbix-apm-proxy/       # build do proxy com --with-apm
scripts/
  compose.sh          # executa o docker compose com o ambiente escolhido
templates/            # templates YAML do Zabbix (somente macros, sem valores fixos)
```

Os arquivos `config/*.env` reais estão no `.gitignore` e **nunca** são versionados.

## Início rápido (DEV)

```sh
cp config/dev.env.example config/dev.env   # ajuste senhas e caminhos
scripts/compose.sh dev core up -d          # stack principal
scripts/compose.sh dev app up -d --build   # demonstração APM (opcional)
```

Para conferir o compose com as variáveis já aplicadas:

```sh
scripts/compose.sh dev core config
```

Detalhes da demonstração APM em [Docker/README.md](Docker/README.md).

## Fluxo DEV → PROD

1. Desenvolver e testar aqui, com `config/dev.env`.
2. Copiar o repositório para o GitLab corporativo.
3. Lá, criar `config/prod.env` a partir de `config/prod.env.example` com os valores reais
   (de preferência vindos do cofre de senhas ou das variáveis protegidas do CI).
4. Executar com `scripts/compose.sh prod core up -d`.
5. Para templates: importar o YAML sem alterações e ajustar apenas as macros
   (veja [templates/README.md](templates/README.md)).

## Regras para manter o repositório genérico

- Nenhum hostname, IP, URL, usuário ou senha real no código, nem como valor padrão.
- Toda nova configuração específica de ambiente vira variável e é adicionada aos
  **dois** arquivos `config/*.env.example`.
- Nenhum dado do ambiente corporativo volta para este repositório.
