# Aplicação demonstrativa com OpenTelemetry e Zabbix

Esta composição separada executa uma aplicação de login (porta `APP_PORT`, padrão 8080), um OpenTelemetry Collector e um proxy Zabbix que recebe OTLP gRPC. O Collector encaminha logs, traces e métricas para o proxy na porta 4317. Como a imagem oficial `alpine-trunk` não inclui o receptor APM, o Compose compila localmente um proxy com `--with-apm`.

## Inicialização

Todos os comandos são executados pela raiz do repositório.

1. Crie o arquivo de ambiente, se ainda não existir, e ajuste os valores:

   ```sh
   cp config/dev.env.example config/dev.env
   ```

2. Inicie a composição principal para criar o Zabbix e a rede compartilhada:

   ```sh
   scripts/compose.sh dev core up -d
   ```

3. Registre no frontend do Zabbix um proxy **ativo** com o mesmo nome definido em `ZBX_PROXY_HOSTNAME` (padrão: `zabbix-apm-proxy`).

4. Inicie a aplicação e a coleta:

   ```sh
   scripts/compose.sh dev app up -d --build
   ```

A configuração do proxy é gerada pelo próprio Compose (bloco `configs`) a partir de `ZBX_PROXY_SERVER`, `ZBX_PROXY_HOSTNAME` e `ZBX_PROXY_APM_PORT`. O banco SQLite do proxy fica em `${DATA_DIR}/zabbix-apm-proxy`. A aplicação demonstrativa usa o usuário definido por `APP_USERNAME` e a senha definida por `APP_PASSWORD`.

## Exibir a telemetria no Zabbix

No frontend, crie um host para a aplicação, associe-o ao proxy definido em `ZBX_PROXY_HOSTNAME` e importe/aplique o template oficial **Generic OpenTelemetry by OTLP**. O template depende do suporte a APM/OTLP do Zabbix 8.0 ou superior. A imagem `alpine-trunk` usada aqui precisa conter esse suporte.

Faça login e logout em `http://localhost:${APP_PORT}` (padrão 8080) para gerar tráfego. O SDK envia traces, métricas HTTP e métricas de login, além de logs de tentativas de autenticação. A atualização dos itens no Zabbix segue os intervalos configurados no template.

Este exemplo é para desenvolvimento local. Não o exponha à internet sem adicionar TLS, proteção CSRF, armazenamento de sessão apropriado e credenciais fortes.
