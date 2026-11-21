# Kimbo JS (pt-BR)

**Cartografia passiva de APIs para pentests autorizados.**  
Mapeia o tráfego que a página já faz, ancora IDs da sessão em placeholders e entrega um ledger com evidências para teste manual.

> Mapeia a superfície. Nunca desfere um golpe.

A extensão **nunca chama endpoints descobertos**. Não escaneia, não faz replay, não fuzza e não explora. O pentester decide o que testar; o Kimbo prepara o handoff.

## Instalação

Requisitos: Chrome/Chromium 111+.

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta `kimbo-js/`.
4. Fixe o Kimbo JS na barra de ferramentas.

## Uso

1. Abra o alvo em uma aba normal.
2. Clique no ícone do Kimbo.
3. Leia o gate de escopo, escolha se inclui hosts API do mesmo site e clique em **Seal this origin**.
4. Aceite o prompt de permissão do Chrome para aquela origem exata.
5. Recarregue a página se quiser capturar as chamadas do carregamento inicial.
6. Navegue pelo app normalmente (login, listas, detalhes, troca de tenant autorizada).
7. Use **Capture context** depois de logar ou trocar de tenant.
8. Em **Context → JS bundles**, use **Read cached** para dissecar chunks já carregados ou **Paste JS** para colar um bundle do DevTools Sources/Burp.
9. Revise o ledger:
   - `Anchored` / `Likely` / `Type-only` indicam a confiança do preenchimento.
   - Fixe (pin) os valores em que você confia.
   - Leia os cartões de teste manual e as evidências.
10. Exporte para JSON, CSV, URLs do Burp, blocos raw do Repeater ou coleção Postman.

## O que diferencia

- **Evidence Ledger** — cada endpoint carrega recibos: origem, métodos/status observados, páginas, timestamps e a linhagem de cada valor preenchido.
- **Identity Lattice** — grafo SVG de âncoras da sessão → endpoints.
- **Human Pin** — o matcher sugere; o pentester fixa o valor manualmente.
- **Cache-only JS** — lê bundles do CacheStorage ou com `fetch(..., { cache: 'only-if-cached' })`; cache miss não vira requisição. Fallback: colar o JS.
- **Scope Seal** — sem `host_permissions` amplo; permissão opcional explícita por origem.
- **Hipóteses, não achados** — risco é lead de teste manual, com disclaimer.
- **Privacidade por construção** — tokens, cookies, corpos crus, response bodies e PII nunca são persistidos.

## Permissões

| Permissão | Motivo |
|---|---|
| `storage` | Ledger local em `chrome.storage.local`; nada é enviado a servidor. |
| `scripting` | Injeção dos coletores na origem selada e probe de storage via `executeScript`. |
| `activeTab` | Identificar a aba ativa ao abrir o popup. |
| `webNavigation` | Detectar mudanças de rota em SPAs e bfcache. |
| `optional_host_permissions` | Pedir acesso a uma origem exata quando você sela. |

Não são pedidos: `tabs`, `cookies`, `webRequest`, `debugger`, `history`, `downloads`, `unlimitedStorage` ou `host_permissions` amplo.

## O que nunca é armazenado

- Headers `Authorization`, bearer tokens, JWTs crus, API keys, senhas, CSRF/XSRF.
- Cookies sensíveis; HttpOnly é invisível de qualquer forma.
- Corpos crus de request/response; só campos com forma de ID são reduzidos a candidatos de contexto.
- E-mails, telefones e outras PII.
- HTML/JS completo; scripts inline são parseados localmente e só strings candidatas saem da página.
- Query string, fragmento e credenciais em evidências de página.

Claims JWT são decodificadas **sem verificar assinatura**; só claims de identidade (`sub`, `org_id`, `tenant_id` etc.) são mantidas. O token cru não sai do hook.

## Escopo

- Injeção apenas na origem exata selada.
- Hosts API do mesmo site podem ser **observados** (o tráfego já existe) mas nunca recebem injeção.
- Chamadas para outro domínio registrável são descartadas e contadas.
- Sem suporte a `chrome://`, Web Store, PDFs ou `file://`.
- Perda de permissão é detectada; o ledger vira snapshot somente leitura até re-selar.
- **Unseal origin** para a coleta e remove a permissão; **Purge ledger** apaga os dados locais.

Detalhes: [SCOPE-MODEL.md](docs/SCOPE-MODEL.md) e [PRIVACY.md](docs/PRIVACY.md).

## Arquitetura

```text
DOM / JS inline ─┐
fetch/XHR hook ──┼─► bus do content script ─► service worker ─► session store
storage probe  ──┤        (lote, dedupe)       (orquestração)     (por origem)
chunks JS      ──┘                                   │
                                                     ▼
                                            normalizer → filtro de escopo
                                                     │
                                            matcher + hipóteses de risco
                                                     │
                                            evidence ledger local
                                                     │
                                  popup / painel DevTools / exportadores
```

- Coletores só observam.
- O normalizer é o único lugar com regex de rota/ID/JWT.
- O matcher pontua nome, tipo e proveniência.
- O pipeline deduplica, limita e mantém proveniência.
- O service worker só orquestra.
- A UI nunca faz fetch.

## Exportação

| Formato | Uso |
|---|---|
| JSON ledger | Evidência completa, contexto, fills, risco, bundles, notas. |
| CSV | Uma linha por endpoint. |
| URLs Burp site-map | Uma URL preparada por linha. |
| Burp Repeater raw | Blocos HTTP crus; cole um por vez. Sem auth/corpo. |
| Postman v2.1 | Pastas por host/família, um item por método observado. |

Nenhum export inclui cookies, `Authorization` ou corpos. O pentester traz a própria sessão autorizada.

## Testes

```bash
python3 -I test/run_tests.py
```

O suite tem **170 checagens**:

- auditoria de manifesto/fonte (permissões, CSP, sem código remoto, fetch só cache-only);
- testes de núcleo (normalizer, matcher, risco, pipeline, exporter);
- E2E com a extensão real no Chrome headless, popup, painel, **SPA React 18** e **SSR**;
- prova de zero requisições: o servidor de fixtures registra cada request. A SPA faz exatamente suas 7 chamadas de API; a extensão adiciona zero; o chunk dinâmico é buscado exatamente uma vez.

O prompt nativo de permissão do Chrome não pode ser aceito no headless; o fluxo de selar está documentado em [TESTING.md](docs/TESTING.md) para teste manual.

## Limitações

- Só `http:`/`https:`.
- Injeção por origem exata; hosts do mesmo site são apenas observados.
- Sem WebSocket/EventSource, sem response bodies, sem cookies HttpOnly.
- Leitura cache-only depende de cópia local; use **Paste JS** se não estiver em cache.
- A página pode ver e falsificar mensagens sanitizadas do bridge; isso polui dados, não executa código.
- Caps: 400 endpoints, 250 âncoras, 8 chamadas por endpoint, 60 bundles, 30 páginas.
- Risco é hipótese de triagem, não achado.

## Uso autorizado

Use apenas em sistemas para os quais você tem autorização explícita. O selo de escopo é uma trava técnica, não uma concessão de autorização. Você é responsável pelo escopo, pelas regras de engajamento e pelo tratamento dos dados.

## Doações

Se o Kimbo JS te poupar tempo em um engajamento autorizado e você quiser apoiar o projeto:

**TRON (TRC20)** — envie apenas TRX ou tokens TRC20 na rede TRON:

```
TWPxWzNMEXA4mRvimV9A4z6TmS72jyunaK
```

Confira o endereço no [TronScan](https://tronscan.org/#/address/TWPxWzNMEXA4mRvimV9A4z6TmS72jyunaK). Ativos enviados por outra rede não podem ser recuperados.

## Licença

MIT. Veja [LICENSE](LICENSE) e [NOTICE.md](NOTICE.md).
