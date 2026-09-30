# Catalogo Ofertas

Gerador de catalogo de ofertas com contas, persistencia por usuario e assinatura Stripe.

O cliente entra, monta o catalogo, escolhe layout e imprime. Cada conta guarda o proprio catalogo no servidor.

## O que o app faz

- Login, cadastro e alteracao de senha
- Recuperacao de senha por e-mail (precisa de SMTP)
- Admin cria e remove usuarios
- Catalogo salvo por conta (titulo, periodo, layout e produtos)
- Importacao por texto, PDF e imagem
- Checkout Stripe do plano Pro

## Rodar local

```bash
# Instalar dependencias
npm install

# Copiar variaveis (opcional no local)
cp .env.example .env

# Subir o servidor
npm start
```

Acesse `http://localhost:3000`.

Admin padrao (se as env vars nao forem definidas):

- usuario: `admin`
- senha: `admin123`

Troque essa senha antes de publicar.

## Publicar no GitHub + Render

### 1. Subir o codigo no GitHub

Crie um repositorio e envie o projeto:

```bash
git add .
git commit -m "feat: catalogo com contas, persistencia e stripe"
git remote add origin https://github.com/SEU_USUARIO/catalogo-ofertas.git
git push -u origin main
```

Nao envie `.env` nem a pasta `data/`. Eles ja estao no `.gitignore`.

### 2. Criar o servico no Render

1. Acesse [https://dashboard.render.com](https://dashboard.render.com)
2. New + Web Service
3. Conecte o repositorio do GitHub
4. Runtime: Node
5. Build: `npm install`
6. Start: `npm start`

Se preferir Blueprint, o arquivo `render.yaml` ja descreve o servico.

Apos o primeiro deploy, copie a URL publica (exemplo: `https://catalogo-ofertas.onrender.com`) e use em `APP_URL`.

### 3. Variaveis de ambiente no Render

Em Environment, preencha:

| Variavel | Obrigatorio | Exemplo | Para que serve |
|---|---|---|---|
| `SESSION_SECRET` | sim | chave longa aleatoria | cookie de sessao |
| `ADMIN_USER` | sim | `admin` | login do admin |
| `ADMIN_EMAIL` | sim | `admin@seudominio.com` | e-mail do admin |
| `ADMIN_PASSWORD` | sim | senha forte | senha inicial do admin |
| `APP_URL` | sim | `https://seu-app.onrender.com` | links de reset e retorno do Stripe |
| `STRIPE_SECRET_KEY` | para cobrar | `sk_live_...` ou `sk_test_...` | API Stripe |
| `STRIPE_PRICE_ID` | para cobrar | `price_...` | preco da assinatura |
| `STRIPE_WEBHOOK_SECRET` | para cobrar | `whsec_...` | confirma pagamento |
| `SMTP_HOST` | para e-mail | `smtp.gmail.com` | envio de reset |
| `SMTP_PORT` | para e-mail | `587` | porta SMTP |
| `SMTP_USER` | para e-mail | seu e-mail | autenticacao SMTP |
| `SMTP_PASS` | para e-mail | senha de app | autenticacao SMTP |
| `SMTP_FROM` | opcional | `Catalogo Ofertas <noreply@seudominio.com>` | remetente |

`SESSION_SECRET` pode ser gerado automaticamente se voce usar o Blueprint.

Sem Stripe, o botao **Assinar plano Pro** mostra que o pagamento ainda nao foi configurado. O restante do app funciona.

### 4. Stripe (para alugar o app)

1. Crie conta em [https://dashboard.stripe.com](https://dashboard.stripe.com)
2. Crie um produto de assinatura (ex.: Catalogo Pro, mensal)
3. Copie o Price ID (`price_...`) para `STRIPE_PRICE_ID`
4. Copie a chave secreta para `STRIPE_SECRET_KEY`
5. Em Developers > Webhooks, adicione:

```text
https://seu-app.onrender.com/api/stripe/webhook
```

Eventos:

- `checkout.session.completed`
- `customer.subscription.deleted`

6. Copie o signing secret para `STRIPE_WEBHOOK_SECRET`

Fluxo: o usuario clica em **Assinar plano Pro** na aba Conta, paga no Stripe e o webhook marca a conta como `pro`.

### 5. SMTP (reset de senha)

Sem SMTP, o pedido de "esqueci a senha" nao gera erro para o usuario, mas o e-mail nao sai.

Exemplo Gmail:

- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `SMTP_USER=seu@gmail.com`
- `SMTP_PASS=` senha de app (nao a senha normal da conta)

Depois de salvar as env vars, faca um Manual Deploy no Render.

## Disco e dados

O banco e SQLite em `data/app.db`.

No plano free do Render o disco e efemero: restart pode apagar contas e catalogos. Para producao de verdade, use disco persistente no Render ou troque o SQLite por Postgres.

## Como testar depois do deploy

1. Abra a URL do Render
2. Entre com o admin
3. Crie um usuario em Admin, ou use **Criar conta**
4. Monte um catalogo e recarregue a pagina: os itens devem continuar la
5. Em Conta, teste alterar senha
6. Se Stripe estiver configurado, teste o checkout em modo test

## Arquivos principais

- `index.html` — interface do catalogo
- `server.js` — API, sessao, catalogo e Stripe
- `package.json` — dependencias Node
- `.env.example` — modelo das env vars
- `render.yaml` — Blueprint do Render
- `layouts/` — miniaturas do seletor de layout
