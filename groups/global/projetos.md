# Projetos Ativos

## NanoClaw
Sistema de assistente pessoal via WhatsApp que me roda.

- Repositório host: `/home/micro/nanoclaw` (montado em `/workspace/project` no container)
- Stack: Node.js + TypeScript + Docker + Baileys (WhatsApp)
- Canal ativo: WhatsApp — número dedicado 5511939048650
- Modelo de chat: Gemini 2.5 Flash (conversas simples, roteamento automático)
- Modelo de tarefas: Claude Sonnet 4.6 (tarefas complexas, código, memória)
- Transcrição de áudio: Gemini 2.5 Flash multimodal

### Como buildar e reiniciar
```bash
cd /home/micro/nanoclaw && npm run build
systemctl --user restart nanoclaw
```

### Reconstruir container do agente
```bash
cd /home/micro/nanoclaw && ./container/build.sh
```

### Após editar agent-runner (src/ do container)
```bash
cp /home/micro/nanoclaw/container/agent-runner/src/* \
   /home/micro/nanoclaw/data/sessions/whatsapp_main/agent-runner-src/
systemctl --user restart nanoclaw
```
