# Supabase self-hosted do ops (`mkt-vps`) — runbook

O *porquê* está em `docs/decisions/005-mcp-proprio-para-o-supabase-do-ops.md` e
`006-…`. Isto é o *como*.

- **Host**: `ubuntu@166.0.186.190` (`mkt-vps`), chave `~/.ssh/id_ed25519_stlflix_vps`
- **Diretório**: `/home/ubuntu/supabase-ops/` — `supabase/docker/` é o sparse-clone
  do compose oficial, este overlay vai em cima dele; `mcp-src/` é a cópia de
  `../../mcp-server` que vira a imagem `stl-supabase-mcp`
- **Superfícies**: `https://db.stlflix.com.br/mcp` (MCP, bearer) ·
  `https://db.stlflix.com.br` (Studio, sessão da plataforma) · loopback
  `5433` (Postgres) e `8100` (envoy) por túnel SSH · `8200/admin` só na rede docker

## Subir do zero

```bash
mkdir -p /home/ubuntu/supabase-ops && cd /home/ubuntu/supabase-ops
git clone --filter=blob:none --no-checkout --depth 1 https://github.com/supabase/supabase.git supabase
git -C supabase sparse-checkout init --cone && git -C supabase sparse-checkout set docker && git -C supabase checkout
python3 gen-env.py                                   # .env com segredos fortes, chmod 600, recusa sobrescrever
cp docker-compose.override.yml supabase/docker/      # este arquivo
docker build -t stl-supabase-mcp:0.2.0 mcp-src       # ../../mcp-server copiado para cá
cd supabase/docker && docker compose up -d db meta rest auth studio api-gw mcp
```

Só esses seis serviços do upstream: `realtime`, `storage`, `imgproxy`,
`functions` e `supavisor` ficam de fora (RAM sem swap). Voltam com
`docker compose up -d <serviço>`.

## Colaborador novo

Pela plataforma (módulo **Supabase**, projeto `supabase`) — é ela que chama a API
admin do MCP. Na mão, do host: ver `../../mcp-server/README.md`.

## DNS

`db.stlflix.com.br` → proxy laranja da Cloudflare para esta máquina (SSL **Full**,
não Full Strict: o TLS de origem é o self-signed do Traefik). Um nível só de
subdomínio, para o certificado universal da Cloudflare cobrir.

**O registro ainda não existe** — os routers estão de pé e inertes; o Traefik
responde 404 a host sem router, e sem DNS não chega pedido nenhum. Enquanto isso,
o acesso é por túnel SSH (`8100` Studio, `8200` MCP, `5433` Postgres).

**Se for possível criar na zona `stlflix.com` em vez da `.com.br`, crie lá.**
Medido em 2026-09-11: a `.com.br` tem Cache Everything na **zona inteira** (o apex
`stlflix.com.br` guarda URL nova: `MISS` e depois `HIT`), e a `.com` não
(`research.stlflix.com` e `n8n-ops.stlflix.com` dão `DYNAMIC` nas duas chamadas).
Um host em `.com` nasce sem o vazamento do
[AD-028 da plataforma](https://github.com/stlflix/plataforma-product-ops/blob/main/docs/decisions/028-toda-resposta-autenticada-de-api-entra-no-edge.md);
um em `.com.br` nasce com ele. É trocar `STUDIO_HOST` no `.env`.

## Atualizar o MCP

```bash
rsync -a --delete --exclude node_modules ~/Projetos/stl-plugin/mcp-server/ mkt-vps:/home/ubuntu/supabase-ops/mcp-src/
ssh mkt-vps 'cd /home/ubuntu/supabase-ops && docker build -t stl-supabase-mcp:<tag> mcp-src && sed -i "s/^MCP_IMAGE_TAG=.*/MCP_IMAGE_TAG=<tag>/" supabase/docker/.env && cd supabase/docker && docker compose up -d mcp'
```
