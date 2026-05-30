# 🍪 Kimi Cookies — Guia de Manutenção

## O que é este arquivo?
Este diretório contém o backup persistente dos cookies de login do Kimi Web.
Quando o Chrome é reiniciado ou os cookies expiram, o sistema tenta
restaurá-los automaticamente a partir deste backup.

## Arquivos
- `kimi-cookies.json` — Backup automático dos cookies (atualizado a cada 5 min)
- `kimi-cookies.manual.json` — Copie aqui cookies exportados manualmente

## Se o Kimi pedir login de novo

### Opção 1: Login manual (recomendado)
1. Abra o Chrome na porta 9222 (já deve estar aberto)
2. Vá para https://kimi.com
3. Faça login com suas credenciais
4. O sistema salvará os cookies automaticamente em até 5 minutos

### Opção 2: Restaurar do backup
```bash
# O sistema tenta isso automaticamente, mas se falhar:
node -e "
const fs = require('fs');
const cookies = JSON.parse(fs.readFileSync('kimi-cookies.json', 'utf8'));
console.log('Cookies disponíveis:', cookies.length);
"
```

### Opção 3: Exportar do seu Chrome pessoal
1. Instale a extensão "EditThisCookie" ou "Cookie-Editor"
2. Exporte os cookies de kimi.com
3. Salve em `kimi-cookies.manual.json`
4. Reinicie o backend

## Por que os cookies expiram?
- O Kimi usa sessões de curta duração (JWT tokens)
- Reiniciar o Chrome invalida a sessão
- Tokens de refresh podem expirar após dias de inatividade

## Solução definitiva
A melhor solução é manter o Chrome sempre aberto com o perfil persistente
`~/.luna/chrome-profile`. Nunca feche esta janela do Chrome.
