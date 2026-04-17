# Projetos Ativos

## NanoClaw
Sistema de assistente pessoal via WhatsApp que me roda.

- Repositório: /home/micro/nanoclaw (montado em /workspace/nanoclaw no meu container)
- Stack: Node.js + TypeScript + Docker + Baileys (WhatsApp)
- Canal ativo: WhatsApp (número dedicado 5511939048650)
- Modelo de chat: Gemini 2.5 Flash (conversas simples)
- Modelo de tarefas: Claude Sonnet (tarefas complexas, código, memória)
- Transcrição de áudio: Gemini 2.5 Flash multimodal

### Como atualizar o NanoClaw
```bash
# Editar código em /workspace/nanoclaw/src/
cd /workspace/nanoclaw && npm run build
systemctl --user restart nanoclaw  # ou via SSH na VPS
```

### Reconstruir container do agente
```bash
cd /workspace/nanoclaw && ./container/build.sh
```
