/**
 * Phase 5 — Launch templates.
 *
 * Pure data. Each template lists 6–10 representative tasks with a
 * `daysFromLaunch` offset (negative = before launch day, positive = after)
 * plus an owner hint and area. The bot turns this into Notion tasks
 * by computing `deadline = launchDate + daysFromLaunch`.
 *
 * Owner hints follow Haven defaults:
 *   Madalena → creative direction / studio voice
 *   Mafalda  → ops / marketing execution
 *   Beatriz  → tech / data
 */
export const LAUNCH_TEMPLATES = {
    "programa-novo": [
        {
            title: "Brief criativo do {name}",
            ownerHint: "Madalena",
            area: "Marketing",
            daysFromLaunch: -30,
            priority: "1. Alta",
        },
        {
            title: "Sessão de fotos para {name}",
            ownerHint: "Madalena",
            area: "Marketing",
            daysFromLaunch: -21,
            priority: "1. Alta",
        },
        {
            title: "Copy do site para {name}",
            ownerHint: "Mafalda",
            area: "Marketing",
            daysFromLaunch: -14,
            priority: "2. Média",
        },
        {
            title: "Copy de ads para {name}",
            ownerHint: "Mafalda",
            area: "Marketing",
            daysFromLaunch: -10,
            priority: "2. Média",
        },
        {
            title: "Posts de social para {name}",
            ownerHint: "Mafalda",
            area: "Marketing",
            daysFromLaunch: -7,
            priority: "2. Média",
        },
        {
            title: "Lançamento de {name}",
            ownerHint: "Madalena",
            area: "Operações",
            daysFromLaunch: 0,
            priority: "1. Alta",
        },
        {
            title: "Follow-up pós-lançamento de {name}",
            ownerHint: "Mafalda",
            area: "Marketing",
            daysFromLaunch: 3,
            priority: "2. Média",
        },
        {
            title: "Análise de métricas de {name}",
            ownerHint: "Beatriz",
            area: "Tech",
            daysFromLaunch: 14,
            priority: "2. Média",
        },
    ],
    parceria: [
        {
            title: "Kickoff da parceria com {name}",
            ownerHint: "Madalena",
            area: "Parcerias",
            daysFromLaunch: -30,
            priority: "1. Alta",
        },
        {
            title: "Brief da parceria com {name}",
            ownerHint: "Mafalda",
            area: "Parcerias",
            daysFromLaunch: -21,
            priority: "1. Alta",
        },
        {
            title: "Mock-ups da parceria com {name}",
            ownerHint: "Madalena",
            area: "Parcerias",
            daysFromLaunch: -14,
            priority: "2. Média",
        },
        {
            title: "Alinhamento final com {name}",
            ownerHint: "Madalena",
            area: "Parcerias",
            daysFromLaunch: -7,
            priority: "1. Alta",
        },
        {
            title: "Lançamento da parceria com {name}",
            ownerHint: "Madalena",
            area: "Parcerias",
            daysFromLaunch: 0,
            priority: "1. Alta",
        },
        {
            title: "Retrospectiva da parceria com {name}",
            ownerHint: "Mafalda",
            area: "Parcerias",
            daysFromLaunch: 7,
            priority: "2. Média",
        },
    ],
    evento: [
        {
            title: "Confirmar data do evento {name}",
            ownerHint: "Madalena",
            area: "Operações",
            daysFromLaunch: -45,
            priority: "1. Alta",
        },
        {
            title: "Save-the-date do evento {name}",
            ownerHint: "Mafalda",
            area: "Marketing",
            daysFromLaunch: -30,
            priority: "1. Alta",
        },
        {
            title: "Abrir registo do evento {name}",
            ownerHint: "Beatriz",
            area: "Tech",
            daysFromLaunch: -21,
            priority: "1. Alta",
        },
        {
            title: "Posts de social do evento {name}",
            ownerHint: "Mafalda",
            area: "Marketing",
            daysFromLaunch: -14,
            priority: "2. Média",
        },
        {
            title: "Lembretes para inscritos no evento {name}",
            ownerHint: "Mafalda",
            area: "Marketing",
            daysFromLaunch: -7,
            priority: "2. Média",
        },
        {
            title: "Dia do evento {name}",
            ownerHint: "Madalena",
            area: "Operações",
            daysFromLaunch: 0,
            priority: "1. Alta",
        },
        {
            title: "Mensagem de agradecimento aos participantes do evento {name}",
            ownerHint: "Mafalda",
            area: "Cliente",
            daysFromLaunch: 1,
            priority: "2. Média",
        },
    ],
    influencer: [
        {
            title: "Brief para influencer {name}",
            ownerHint: "Mafalda",
            area: "Influencers",
            daysFromLaunch: -21,
            priority: "1. Alta",
        },
        {
            title: "Aprovar conteúdo de {name}",
            ownerHint: "Madalena",
            area: "Influencers",
            daysFromLaunch: -7,
            priority: "1. Alta",
        },
        {
            title: "Agendar post de {name}",
            ownerHint: "Mafalda",
            area: "Influencers",
            daysFromLaunch: -2,
            priority: "2. Média",
        },
        {
            title: "Post de {name}",
            ownerHint: "Mafalda",
            area: "Influencers",
            daysFromLaunch: 0,
            priority: "1. Alta",
        },
        {
            title: "Métricas do post de {name}",
            ownerHint: "Beatriz",
            area: "Tech",
            daysFromLaunch: 3,
            priority: "2. Média",
        },
    ],
};
