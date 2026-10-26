# Templates do Zabbix

Templates exportados do frontend em YAML (**Data collection → Templates → Export**).

## Convenção: tudo que muda entre ambientes vira macro

Os templates deste repositório devem ser **genéricos**. Nenhum hostname, IP, URL,
usuário, senha ou nome de cliente fica fixo nos itens, triggers ou discovery.
Esses valores são definidos como **macros de usuário** com um valor padrão neutro.

| Tipo de valor | Exemplo de macro | Onde sobrescrever no ambiente |
|---|---|---|
| Endereços e URLs | `{$APP.URL}`, `{$DB.HOST}` | Host |
| Portas | `{$DB.PORT}` | Host ou template filho |
| Limites de trigger | `{$CPU.UTIL.CRIT}`, `{$DISK.PUSED.WARN}` | Host ou global |
| Intervalos | `{$APP.INTERVAL}` | Template ou host |
| Credenciais | `{$APP.USER}`, `{$APP.PASSWORD}` | Host, como macro **Secret** ou **Vault** |

### Regras

- Prefixe as macros com o nome do componente (`{$NGINX.…}`, `{$PG.…}`) para evitar colisões.
- Credenciais: o valor no template fica vazio ou como placeholder; no ambiente, use macro do tipo **Secret text** ou **Vault secret**.
- Use **macros com contexto** para limites por instância, por exemplo `{$DISK.PUSED.WARN:"/var"}`.
- Documente cada macro no campo *Description* da própria macro.

## Fluxo DEV → PROD

1. Desenvolver e testar o template no laboratório (DEV).
2. Exportar em YAML e versionar aqui.
3. No ambiente corporativo, importar o mesmo YAML **sem alterações**.
4. Ajustar apenas os valores das macros no host, no template filho ou nas macros globais.
