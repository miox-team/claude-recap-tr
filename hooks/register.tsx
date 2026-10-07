import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModeChoice, Narration, NarrationPhase, RecapMode } from '../types'

type Scope = 'all' | 'here'
type Action = RecapMode | 'status'
type Modes = { all: RecapMode; here: RecapMode }
type VoicePath = 'speak' | 'stop' | 'shutdown'
type VoiceEndpoint = { target: readonly string[]; base: string; proof?: string }

const SUMMARY_MODEL = 'claude-sonnet-5-5'
const VOICE_DIR_UNDER_HOME = '.claude/recap'
const VOICE_PYTHON_UNDER_HOME = {
  posix: '.local/share/recap-ema/bin/python',
  windows: '.local/share/recap-ema/Scripts/python.exe',
}
const VOICE_SERVER_UNDER_PLUGIN = 'tts/ema_server.py'
const SPEAK_TIMEOUT_SECONDS = 120
const CONTROL_TIMEOUT_SECONDS = 5
const CONNECT_TIMEOUT_SECONDS = 1
const VOICE_ANSWERS: readonly string[] = ['200', '409', '503']
const SPEAK_DIRECTLY_BELOW = 200
const ANSWER_HEAD_CHARS = 2000
const ANSWER_TAIL_CHARS = 4000
const SUMMARY_TIMEOUT_MS = 30_000
const STATE_FILE = '.claude/recap.json'
const MODES: readonly RecapMode[] = ['on', 'mute', 'off']
const MODE_MEANINGS: Record<RecapMode, string> = {
  on: 'özet sesli okunur',
  mute: 'özet yazılır, ses yok',
  off: 'özet yok',
}
const NEVER_CHOSEN: ModeChoice = { mode: 'on', at: 0 }
const USAGE =
  'Değiştirmek için: /recap on, /recap mute ya da /recap off. Sonuna "hepsi" eklerseniz tüm oturumlar değişir.'
const ON_WORDS = ['aç', 'ac', 'on']
const MUTE_WORDS = ['sessiz', 'sustur', 'mute']
const OFF_WORDS = ['kapat', 'off']
const STATUS_WORDS = ['durum', 'status']
const ALL_SESSIONS_WORDS = ['hepsi', 'hepsini', 'heryerde', 'genel', 'tümü', 'tumu', 'all', 'everywhere']

const narration = atom({ plugin: 'recap', key: 'narration' } as const, null)
const choiceHere = atom({ plugin: 'recap', key: 'choiceHere' } as const, null)

const SUMMARY_SYSTEM = [
  'Sen bir özetleyicisin. <cevap> etiketi içindeki metni sesli okunacak çok kısa bir özete çevir.',
  'Metni yazan kişi gibi, birinci tekil kişiyle ("yaptım", "buldum") yaz.',
  'Yalnız metinde yazan bilgiyi kullan. Hiçbir şey uydurma, hiçbir şey ekleme.',
  'Yalnız iki şey söyle:',
  '(1) Eylem: kullanıcının yapması, cevaplaması ya da seçmesi gereken şey. Varsa İLK cümlede söyle.',
  '(2) Neden ve sonuç: ne oldu ve neden oldu. Tek cümle.',
  'Bunları SÖYLEME: adımlar, nasıl yapıldığı, kontroller, testler, ölçümler, dosya ve komut adları, seçenek listeleri, ayrıntılar.',
  'Sayı yalnız kullanıcının kararı ona bağlıysa söylenir.',
  'Eylem yoksa tek cümle yaz. Eylem varsa en çok iki cümle yaz. Toplam en çok 20 kelime.',
  'Her cümle en çok 12 kelime olsun. Cümleleri noktalı virgülle birleştirme.',
  'Etken çatı, basit ve somut kelimeler kullan.',
  'Bir kural eklendi demek ile bir davranış kanıtlandı demek aynı şey değil; karıştırma.',
  'Markdown, kod, dosya yolu, liste ve etiket kullanma. Yalnız özeti yaz.',
  '',
  'Eylemli örnek: "Kalıcı kurulum için bir komutu sizin çalıştırmanız gerekiyor. İzin sistemi otomatik kurulumu engelledi."',
  'Eylemsiz örnek: "Özetler her adımı anlattığı için uzundu, kuralı daralttım."',
].join('\n')

const clipKeepingTail = (answer: string) =>
  answer.length <= ANSWER_HEAD_CHARS + ANSWER_TAIL_CHARS
    ? answer
    : `${answer.slice(0, ANSWER_HEAD_CHARS)}\n[...]\n${answer.slice(-ANSWER_TAIL_CHARS)}`

const summaryPrompt = (answer: string) =>
  `<cevap>\n${clipKeepingTail(answer)}\n</cevap>`

const toSpeakable = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const phaseLabel = (n: Narration) => {
  if (n.phase === 'summarizing') return 'Özet hazırlanıyor…'
  if (n.phase === 'busy') return `Makine yoğun, sesli okunmadı. ${n.text}`
  if (n.phase === 'noVoice') return `Ses üretilemedi, sesli okunmadı. ${n.text}`
  return n.text
}

const isTalking = (n: Narration) => n.phase === 'summarizing' || n.phase === 'speaking'

let generation = 0

const setNarration = ($: EngineInterface, next: Narration | null) =>
  update($, narration, () => next)

const isWindows = async ($: EngineInterface) => (await $.env.get('OS')) === 'Windows_NT'

const homeDir = async ($: EngineInterface) =>
  (await isWindows($)) ? await $.env.get('USERPROFILE') : await $.env.get('HOME')

const voiceDir = async ($: EngineInterface) => `${await homeDir($)}/${VOICE_DIR_UNDER_HOME}`

const readVoiceEndpoint = async ($: EngineInterface): Promise<VoiceEndpoint | null> => {
  const dir = await voiceDir($)
  if (!(await isWindows($))) return { target: ['--unix-socket', `${dir}/voice.sock`], base: 'http://localhost' }
  const path = `${dir}/voice.json`
  if (!(await $.fs.exists(path))) return null
  try {
    const { port, token, proof } = JSON.parse(String(await $.fs.read(path)))
    return { target: ['-H', `X-Recap-Token: ${token}`], base: `http://127.0.0.1:${port}`, proof }
  } catch {
    return null
  }
}

const askVoice = async ($: EngineInterface, endpoint: VoiceEndpoint, path: VoicePath, body?: string) => {
  const timeoutSeconds = path === 'speak' ? SPEAK_TIMEOUT_SECONDS : CONTROL_TIMEOUT_SECONDS
  const json = body === undefined ? [] : ['-H', 'Content-Type: application/json', '--data-binary', '@-']
  const result = await $.process.run(
    [
      'curl',
      '-s',
      '--connect-timeout',
      String(CONNECT_TIMEOUT_SECONDS),
      '--max-time',
      String(timeoutSeconds),
      '-w',
      '\n%{http_code}',
      '-X',
      'POST',
      ...json,
      ...endpoint.target,
      `${endpoint.base}/${path}`,
    ],
    { stdin: body, timeoutMs: (timeoutSeconds + 5) * 1000 },
  )
  const cut = result.stdout.lastIndexOf('\n')
  const proof = result.stdout.slice(0, Math.max(cut, 0))
  const code = result.stdout.slice(cut + 1).trim()
  const isRecap = VOICE_ANSWERS.includes(code) && (endpoint.proof === undefined || proof === endpoint.proof)
  return isRecap ? code : null
}

const tellVoice = async ($: EngineInterface, path: Exclude<VoicePath, 'speak'>) => {
  const endpoint = await readVoiceEndpoint($)
  if (endpoint !== null) await askVoice($, endpoint, path)
}

const startVoiceServer = async ($: EngineInterface) => {
  const python = (await isWindows($)) ? VOICE_PYTHON_UNDER_HOME.windows : VOICE_PYTHON_UNDER_HOME.posix
  return $.process.run([
    `${await homeDir($)}/${python}`,
    '-I',
    `${$.plugin.root}/${VOICE_SERVER_UNDER_PLUGIN}`,
    '--dir',
    await voiceDir($),
    '--detach',
  ])
}

const speakAloud = async ($: EngineInterface, text: string): Promise<NarrationPhase> => {
  const body = JSON.stringify({ text })
  const ask = async () => {
    const endpoint = await readVoiceEndpoint($)
    return endpoint === null ? null : askVoice($, endpoint, 'speak', body)
  }
  let answer = await ask()
  if (answer === null) {
    await startVoiceServer($)
    answer = await ask()
  }
  if (answer === '503') return 'busy'
  return answer === null ? 'noVoice' : 'done'
}

const silence = async ($: EngineInterface) => {
  generation += 1
  if ((await read($, narration))?.phase === 'speaking') await tellVoice($, 'stop')
}

const stateFilePath = async ($: EngineInterface) => `${await homeDir($)}/${STATE_FILE}`

const isMode = (value: unknown): value is RecapMode => MODES.includes(value as RecapMode)

const choiceForAll = async ($: EngineInterface): Promise<ModeChoice> => {
  const path = await stateFilePath($)
  if (!(await $.fs.exists(path))) return NEVER_CHOSEN
  try {
    const { mode, at } = JSON.parse(String(await $.fs.read(path)))
    return isMode(mode) ? { mode, at: typeof at === 'number' ? at : 0 } : NEVER_CHOSEN
  } catch {
    return NEVER_CHOSEN
  }
}

const setChoiceForAll = async ($: EngineInterface, choice: ModeChoice) =>
  $.fs.write(await stateFilePath($), JSON.stringify(choice))

const currentModes = async ($: EngineInterface): Promise<Modes> => {
  const all = await choiceForAll($)
  const here = await read($, choiceHere)
  const isHereNewer = here !== null && here.at >= all.at
  return { all: all.mode, here: isHereNewer ? here.mode : all.mode }
}

const currentMode = async ($: EngineInterface) => (await currentModes($)).here

const showModeStatus = async ($: EngineInterface) => {
  const mode = await currentMode($)
  $.ui.status(mode === 'on' ? undefined : `recap: ${mode}`)
}

const parseCommand = (args: string): { scope: Scope; action: Action } => {
  const words = args.toLowerCase().split(/\s+/).filter(Boolean)
  const has = (list: string[]) => words.some(word => list.includes(word))
  const scope = has(ALL_SESSIONS_WORDS) ? 'all' : 'here'
  if (has(STATUS_WORDS)) return { scope, action: 'status' }
  if (has(MUTE_WORDS)) return { scope, action: 'mute' }
  if (has(ON_WORDS)) return { scope, action: 'on' }
  if (has(OFF_WORDS)) return { scope, action: 'off' }
  return { scope, action: 'status' }
}

const describe = (mode: RecapMode) => `${mode} — ${MODE_MEANINGS[mode]}.`

const statusText = ({ all, here }: Modes) =>
  here === all
    ? `Tüm oturumlar ${describe(all)}`
    : `Bu oturum ${describe(here)}\nDiğer oturumlar ${describe(all)}`

const changeText = (scope: Scope, before: Modes, after: Modes) => {
  const isUnchanged = before.all === after.all && before.here === after.here
  const verb = isUnchanged ? 'zaten' : 'artık'
  if (scope === 'all') return `Tüm oturumlar ${verb} ${describe(after.all)}`
  const lead = `Bu oturum ${verb} ${describe(after.here)}`
  return after.here === after.all ? lead : `${lead}\nDiğer oturumlar ${describe(after.all)}`
}

const stop = async ($: EngineInterface) => {
  await silence($)
  await update($, narration, current =>
    current?.phase === 'speaking' ? { ...current, phase: 'done' as const } : null,
  )
}

const applyChoice = async ($: EngineInterface, scope: Scope, mode: RecapMode) => {
  const choice = { mode, at: Date.now() }
  if (scope === 'all') {
    await setChoiceForAll($, choice)
    await update($, choiceHere, () => null)
  } else {
    await update($, choiceHere, () => choice)
  }
  const effective = await currentMode($)
  if (effective !== 'on') await stop($)
  if (effective === 'off') await setNarration($, null)
  if (scope === 'all' && mode !== 'on') await tellVoice($, 'shutdown')
  if (effective === 'on') await startVoiceServer($)
  await showModeStatus($)
}

const summaryToSpeak = async ($: EngineInterface, answer: string, isCurrent: () => boolean) => {
  const speakable = toSpeakable(answer)
  if (speakable.length <= SPEAK_DIRECTLY_BELOW) return speakable

  await setNarration($, { text: '', phase: 'summarizing' })
  const summary = await $.model.complete({
    model: SUMMARY_MODEL,
    system: SUMMARY_SYSTEM,
    prompt: summaryPrompt(answer),
    maxTokens: 300,
    effort: 'low',
    timeoutMs: SUMMARY_TIMEOUT_MS,
  })
  if (!isCurrent()) return null
  if (!summary.isAnswered) {
    $.ui.toast(`Özet hazırlanamadı (${summary.reason})`)
    await setNarration($, null)
    return null
  }
  return toSpeakable(summary.text)
}

const narrate = async ($: EngineInterface, answer: string, withVoice: boolean) => {
  const id = ++generation
  const isCurrent = () => id === generation

  const text = await summaryToSpeak($, answer, isCurrent)
  if (text === null) return
  if (!withVoice) return setNarration($, { text, phase: 'done' })

  await setNarration($, { text, phase: 'speaking' })
  let phase: NarrationPhase = 'done'
  try {
    phase = await speakAloud($, text)
  } finally {
    if (isCurrent()) await setNarration($, { text, phase })
  }
}

const reportNarrationError = ($: EngineInterface, error: unknown) =>
  $.ui.toast(`Recap hatası: ${error instanceof Error ? error.message : String(error)}`)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'recap',
      description:
        'Tur özeti: on sesli, mute yalnız yazı, off kapalı. Boş bırakırsanız durumu gösterir. Sonuna "hepsi" eklerseniz tüm oturumlar.',
    })
    await showModeStatus($)

    return next(e)
  })

  on('command.run', { command: 'recap' }, async ($, e) => {
    const { scope, action } = parseCommand(e.args)
    const before = await currentModes($)
    if (action === 'status') return { text: `${statusText(before)}\n${USAGE}` }

    await applyChoice($, scope, action)
    return { text: changeText(scope, before, await currentModes($)) }
  })

  on('prompt.submit', async ($, e, next) => {
    await silence($)
    await setNarration($, null)
    await showModeStatus($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    const isMainAnswer = e.reason === 'answer' && e.agentId === undefined
    if (!isMainAnswer || e.answer.trim() === '') return result

    const mode = await currentMode($)
    if (mode === 'off') return result

    void narrate($, e.answer, mode === 'on').catch(error => reportNarrationError($, error))

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, narration)
    if (current === null || e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const isActive = isTalking(current)

    return (
      <Box flexDirection="column">
        <Text dimColor={!isActive}>{phaseLabel(current)}</Text>
        <Box>
          {isActive ? (
            <Button key="stop" label="Sustur" onPress={() => stop($)} />
          ) : (
            <Button key="close" label="Kapat" onPress={() => setNarration($, null)} />
          )}
        </Box>
      </Box>
    )
  })
}
