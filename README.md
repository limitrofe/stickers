# WhatsApp Sticker Bot

Este bot converte automaticamente imagens enviadas para ele em figurinhas (stickers) do WhatsApp.

## Pré-requisitos

- Node.js instalado (versão 14 ou superior recomendada)
- `ffmpeg` instalado no sistema (necessário para conversão de mídia em alguns casos, embora a biblioteca tente lidar com isso)

## Instalação

1. Clone o repositório ou baixe os arquivos.
2. Na pasta do projeto, instale as dependêcias:

```bash
npm install
```

## Como Usar

1. Inicie o bot:

```bash
node index.js
```

2. Um QR Code aparecerá no terminal.
3. Abra o WhatsApp no seu celular, vá em **Aparelhos conectados** > **Conectar um aparelho**.
4. Escaneie o QR Code.
5. Assim que aparecer "Client is ready!", o bot está pronto.
6. Envie uma imagem para o número do bot (ou use o próprio número dele enviando para você mesmo).
7. O bot responderá com a figurinha da imagem.

## Notas

- O bot armazena a sessão localmente na pasta `.wwebjs_auth`. Se precisar desconectar, apague essa pasta ou desconecte via WhatsApp no celular.
