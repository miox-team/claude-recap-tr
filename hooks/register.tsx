import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModeChoice, Narration, NarrationPhase, RecapMode } from '../types'

type Scope = 'all' | 'here'
type Action = RecapMode | 'status'
type Modes = { all: RecapMode; here: RecapMode }

const SUMMARY_MODEL = 'claude-sonnet-5-5'
const VOICE_HOST = '127.0.0.1'
const DEFAULT_VOICE_PORT = '29617'
const VOICE_PYTHON_UNDER_HOME = '.local/share/recap-ema/bin/python'
const VOICE_SERVER_UNDER_PLUGIN = 'tts/ema_server.py'
const VOICE_TIMEOUT_SECONDS = 30
const VOICE_START_RETRIES = 15
const CURL_COULD_NOT_CONNECT = 7
const BUSY_LOAD_PER_CORE = 2
const SPEAK_DIRECTLY_BELOW = 200
const ANSWER_HEAD_CHARS = 2000
const ANSWER_TAIL_CHARS = 4000
const SUMMARY_TIMEOUT_MS = 30_000
const SPEECH_TIMEOUT_MS = 120_000
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

const loadPerCore = (sysctlOutput: string) => {
  const [loadLine = '', coresLine = ''] = sysctlOutput.trim().split('\n')
  const oneMinuteLoad = Number.parseFloat(loadLine.replace(/[{}]/g, '').trim().split(/\s+/)[0] ?? '')
  const cores = Number.parseInt(coresLine, 10)
  return cores > 0 ? oneMinuteLoad / cores : Number.NaN
}

const isMachineBusy = async ($: EngineInterface) => {
  const result = await $.process.run(['sysctl', '-n', 'vm.loadavg', 'hw.ncpu'])
  return result.exitCode === 0 && loadPerCore(result.stdout) > BUSY_LOAD_PER_CORE
}

let generation = 0

const setNarration = ($: EngineInterface, next: Narration | null) =>
  update($, narration, () => next)

const stopPlayer = ($: EngineInterface) => $.process.run(['killall', 'afplay'])

const silence = async ($: EngineInterface) => {
  generation += 1
  await stopPlayer($)
}

const voicePort = async ($: EngineInterface) => (await $.env.get('RECAP_TTS_PORT')) ?? DEFAULT_VOICE_PORT

const voiceUrl = (port: string, endpoint: 'speak' | 'shutdown') =>
  `http://${VOICE_HOST}:${port}/${endpoint}`

const startVoiceServer = async ($: EngineInterface, port: string) =>
  $.process.run([
    `${await $.env.get('HOME')}/${VOICE_PYTHON_UNDER_HOME}`,
    '-I',
    `${$.plugin.root}/${VOICE_SERVER_UNDER_PLUGIN}`,
    '--port',
    port,
    '--detach',
  ])

const stopVoiceServer = async ($: EngineInterface) =>
  $.process.run(['curl', '-sS', '-X', 'POST', '--max-time', '2', voiceUrl(await voicePort($), 'shutdown')])

const fetchSpeech = (
  $: EngineInterface,
  { text, port, path, waitForServer }: { text: string; port: string; path: string; waitForServer: boolean },
) => {
  const retry = waitForServer
    ? ['--retry', String(VOICE_START_RETRIES), '--retry-delay', '1', '--retry-connrefused']
    : []
  const retrySeconds = waitForServer ? VOICE_START_RETRIES : 0
  return $.process.run(
    [
      'curl',
      '-sS',
      '--fail',
      '--max-time',
      String(VOICE_TIMEOUT_SECONDS),
      ...retry,
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
      '-o',
      path,
      voiceUrl(port, 'speak'),
    ],
    { stdin: JSON.stringify({ text }), timeoutMs: (VOICE_TIMEOUT_SECONDS + retrySeconds + 5) * 1000 },
  )
}

const recordWithLocalVoice = async ($: EngineInterface, text: string) => {
  const made = await $.process.run(['mktemp', '-t', 'recap'])
  const path = made.stdout.trim()
  if (made.exitCode !== 0 || path === '') return null

  const port = await voicePort($)
  let fetched = await fetchSpeech($, { text, port, path, waitForServer: false })
  if (fetched.exitCode === CURL_COULD_NOT_CONNECT) {
    await startVoiceServer($, port)
    fetched = await fetchSpeech($, { text, port, path, waitForServer: true })
  }
  if (fetched.exitCode === 0) return path

  await $.process.run(['rm', '-f', path])
  return null
}

const playRecording = ($: EngineInterface, path: string) =>
  $.process.run(['afplay', path], { timeoutMs: SPEECH_TIMEOUT_MS })

const speak = async (
  $: EngineInterface,
  text: string,
  isCurrent: () => boolean,
): Promise<NarrationPhase> => {
  const recording = await recordWithLocalVoice($, text)
  if (recording === null) return 'noVoice'
  try {
    if (isCurrent()) {
      await stopPlayer($)
      await playRecording($, recording)
    }
    return 'done'
  } finally {
    await $.process.run(['rm', '-f', recording])
  }
}

const stateFilePath = async ($: EngineInterface) => `${await $.env.get('HOME')}/${STATE_FILE}`

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
  if (scope === 'all' && mode !== 'on') await stopVoiceServer($)
  if (effective === 'on') await startVoiceServer($, await voicePort($))
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

  if (await isMachineBusy($)) {
    if (isCurrent()) await setNarration($, { text, phase: 'busy' })
    return
  }

  await setNarration($, { text, phase: 'speaking' })
  let phase: NarrationPhase = 'done'
  try {
    phase = await speak($, text, isCurrent)
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
