import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

const turn = {
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
} as const

const LONG_ANSWER = 'Dosyayı düzelttim ve testleri çalıştırdım. '.repeat(10)
const SUMMARY = 'Dosyayı düzelttim.'
const STATE_PATH = '/home/test/.claude/recap.json'
const RECORDING_PATH = '/tmp/recap.test'
const VOICE_PYTHON = '/home/test/.local/share/recap-ema/bin/python'
const SPEAK_URL = 'http://127.0.0.1:29617/speak'
const SHUTDOWN_URL = 'http://127.0.0.1:29617/shutdown'
const CONNECTION_REFUSED = 7
const HTTP_ERROR = 22

type Call = { argv: readonly string[]; stdin?: string }

const isSpeakRequest = (argv: readonly string[]) => argv.some(arg => arg.endsWith('/speak'))

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const finished = (stdout = '', exitCode = 0) =>
  ({ value: { exitCode, stdout, stderr: '' } }) as never

const stubHost = (
  on: On,
  files: Map<string, string> = new Map(),
  statuses: unknown[] = [],
  env: Record<string, string> = { HOME: '/home/test' },
) => {
  on('env.get', (_$, e) => ({ value: env[e.name] }) as never)
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }) as never)
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }) as never)
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined } as never
  })
  return files
}

const stubSummary = (on: On) => {
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: SUMMARY } }) as never)
}

const BUSY_LOAD_REPORT = '{ 217.48 159.12 129.90 }\n18'
const CALM_LOAD_REPORT = '{ 9.00 8.00 7.00 }\n18'

const stubProcess = (
  on: On,
  calls: Call[],
  {
    curlExitCode = 0,
    speakExitCodes = [] as number[],
    slowCommand = '',
    slowMs = 0,
    loadReport = '',
  } = {},
) =>
  on('process.run', async (_$, e) => {
    const [command] = e.argv
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    if (command === slowCommand) await pause(slowMs)
    if (command === 'sysctl') return finished(loadReport)
    if (command === 'mktemp') return finished(`${RECORDING_PATH}\n`)
    if (command === 'curl' && isSpeakRequest(e.argv)) return finished('', speakExitCodes.shift() ?? curlExitCode)
    return finished()
  })

const finishTurn = async ($: Engine, answer = LONG_ANSWER) => {
  await $.turn.complete({ ...turn, answer, reason: 'answer' })
  await pause(60)
}

const commandsOf = (calls: Call[]) => calls.map(call => call.argv[0])

const spawnsOf = (calls: Call[]) => calls.filter(call => call.argv[0] === VOICE_PYTHON)

const shutdownsOf = (calls: Call[]) => calls.filter(call => call.argv.includes(SHUTDOWN_URL))

const callOf = (calls: Call[], command: string) => calls.find(call => call.argv[0] === command)

const bandProps = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { bodyRows: 10, offset: 0 },
} as never

const mountBand = ($: Engine) =>
  $.ui.mount({
    plugin: 'recap',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: bandProps,
  })

test('uzun cevap özetlenir ve EMA sesiyle okunur', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls)

  await finishTurn($)

  const request = callOf(calls, 'curl')
  expect(JSON.parse(request?.stdin ?? '{}')).toEqual({ text: SUMMARY })
  expect(request?.argv).toContain(SPEAK_URL)
  expect(spawnsOf(calls)).toEqual([])
  expect(callOf(calls, 'afplay')?.argv).toEqual(['afplay', RECORDING_PATH])
  expect(commandsOf(calls)).not.toContain('say')
  expect(calls.at(-1)?.argv).toEqual(['rm', '-f', RECORDING_PATH])
})

test('kısa cevap özetlenmeden doğrudan okunur', async ($, on) => {
  const calls: Call[] = []
  let summarized = false
  stubHost(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => {
    summarized = true
    return { value: { isAnswered: false, reason: 'aborted' } } as never
  })
  stubProcess(on, calls)

  await finishTurn($, 'Tamam, **bitti**.')

  expect(summarized).toBe(false)
  expect(JSON.parse(callOf(calls, 'curl')?.stdin ?? '{}')).toEqual({ text: 'Tamam, bitti.' })
  expect(commandsOf(calls)).toContain('afplay')
})

test('EMA sunucusu kapalıysa eklenti onu başlatır, bekler ve okur', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { speakExitCodes: [CONNECTION_REFUSED, 0] })

  await finishTurn($)

  const [spawn] = spawnsOf(calls)
  expect(spawn?.argv[1]).toBe('-I')
  expect(spawn?.argv[2]).toMatch(/\/tts\/ema_server\.py$/)
  expect(spawn?.argv.slice(3)).toEqual(['--port', '29617', '--detach'])
  const speakRequests = calls.filter(call => isSpeakRequest(call.argv))
  expect(speakRequests.length).toBe(2)
  expect(speakRequests[1]?.argv).toContain('--retry-connrefused')
  expect(callOf(calls, 'afplay')?.argv).toEqual(['afplay', RECORDING_PATH])
})

test('sunucu başlatılamazsa ses çalmaz, özet yalnız ekranda kalır', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { curlExitCode: CONNECTION_REFUSED })

  await finishTurn($)

  expect(spawnsOf(calls).length).toBe(1)
  expect(commandsOf(calls)).not.toContain('say')
  expect(commandsOf(calls)).not.toContain('afplay')
  expect(calls.filter(call => call.argv[0] === 'rm').length).toBe(1)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: `Ses üretilemedi, sesli okunmadı. ${SUMMARY}` })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'close' })).toBeDefined()
})

test('sunucu hata verirse yeniden başlatılmaz', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { curlExitCode: HTTP_ERROR })

  await finishTurn($)

  expect(spawnsOf(calls)).toEqual([])
  expect(commandsOf(calls)).not.toContain('afplay')
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: `Ses üretilemedi, sesli okunmadı. ${SUMMARY}` })).toBeDefined()
})

test('RECAP_TTS_PORT sunucunun portunu değiştirir', async ($, on) => {
  const calls: Call[] = []
  stubHost(on, new Map(), [], { HOME: '/home/test', RECAP_TTS_PORT: '31111' })
  stubSummary(on)
  stubProcess(on, calls, { speakExitCodes: [CONNECTION_REFUSED, 0] })

  await finishTurn($)

  expect(callOf(calls, 'curl')?.argv).toContain('http://127.0.0.1:31111/speak')
  expect(spawnsOf(calls)[0]?.argv.slice(3)).toEqual(['--port', '31111', '--detach'])
  expect(commandsOf(calls)).toContain('afplay')
})

test('makine yoğunken özet yalnız ekranda kalır, ses çıkmaz', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { loadReport: BUSY_LOAD_REPORT })

  await finishTurn($)

  expect(commandsOf(calls)).toEqual(['sysctl'])
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: `Makine yoğun, sesli okunmadı. ${SUMMARY}` })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'close' })).toBeDefined()
})

test('makine sakinken EMA sesi kullanılır', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { loadReport: CALM_LOAD_REPORT })

  await finishTurn($)

  expect(commandsOf(calls)).toContain('afplay')
})

test('yük okunamazsa ses yine çalınır', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { loadReport: 'beklenmeyen çıktı' })

  await finishTurn($)

  expect(commandsOf(calls)).toContain('afplay')
})

test('iptal edilen tur konuşmaz', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls)

  await $.turn.complete({ ...turn, answer: LONG_ANSWER, isAborted: true, reason: 'aborted' })
  await pause(60)

  expect(calls).toEqual([])
})

test('Sustur düğmesi konuşmayı keser ve özet ekranda kalır', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { slowCommand: 'afplay', slowMs: 400 })

  await finishTurn($)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: SUMMARY })).toBeDefined()

  await band.press({ key: 'stop' })

  const stops = calls.filter(call => call.argv[0] === 'killall')
  expect(stops.length).toBeGreaterThan(1)
  expect(stops.at(-1)?.argv).toEqual(['killall', 'afplay'])
  expect(await band.find({ type: 'Button', key: 'close' })).toBeDefined()
})

test('ses hazırlanırken Sustur basılırsa çalma hiç başlamaz', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { slowCommand: 'curl', slowMs: 300 })

  await finishTurn($)
  const band = await mountBand($)
  await band.press({ key: 'stop' })
  await pause(400)

  expect(commandsOf(calls)).not.toContain('afplay')
  expect(calls.at(-1)?.argv).toEqual(['rm', '-f', RECORDING_PATH])
})

test('özet hazırlanamazsa bildirim çıkar ve konuşma başlamaz', async ($, on) => {
  const calls: Call[] = []
  const toasts: unknown[] = []
  stubHost(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'aborted' } }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(e)
    return { value: undefined } as never
  })
  stubProcess(on, calls)

  await finishTurn($)

  expect(JSON.stringify(toasts)).toContain('aborted')
  expect(calls).toEqual([])
})

const USAGE_LINE =
  'Değiştirmek için: /recap on, /recap mute ya da /recap off. Sonuna "hepsi" eklerseniz tüm oturumlar değişir.'

test('/recap boş çağrı yalnız durumu gösterir, hiçbir şeyi değiştirmez', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls)

  const first = await $.command.run({ command: 'recap', args: '' })
  expect(first.text).toBe(`Tüm oturumlar on — özet sesli okunur.\n${USAGE_LINE}`)
  expect((await $.command.run({ command: 'recap', args: '' })).text).toBe(first.text)

  await finishTurn($)
  expect(commandsOf(calls)).toContain('afplay')
})

test('/recap mute bu oturumun sesini kapatır, özet yine ekranda görünür', async ($, on) => {
  const calls: Call[] = []
  const statuses: unknown[] = []
  const files = stubHost(on, new Map(), statuses)
  stubSummary(on)
  stubProcess(on, calls)

  const reply = await $.command.run({ command: 'recap', args: 'mute' })
  expect(reply.text).toBe(
    'Bu oturum artık mute — özet yazılır, ses yok.\nDiğer oturumlar on — özet sesli okunur.',
  )
  expect(statuses.at(-1)).toBe('recap: mute')
  await finishTurn($)

  expect(commandsOf(calls)).toEqual(['killall'])
  expect(files.size).toBe(0)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: SUMMARY })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'close' })).toBeDefined()
})

test('aynı durumu yeniden seçmek "zaten" der', async ($, on) => {
  stubHost(on)
  stubProcess(on, [])

  await $.command.run({ command: 'recap', args: 'mute' })
  const again = await $.command.run({ command: 'recap', args: 'mute' })

  expect(again.text).toBe(
    'Bu oturum zaten mute — özet yazılır, ses yok.\nDiğer oturumlar on — özet sesli okunur.',
  )
})

test('/recap off bu oturumda özeti kapatır, /recap on geri açar', async ($, on) => {
  const calls: Call[] = []
  let summaries = 0
  const files = stubHost(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => {
    summaries += 1
    return { value: { isAnswered: true, text: SUMMARY } } as never
  })
  stubProcess(on, calls)

  await $.command.run({ command: 'recap', args: 'kapat' })
  await finishTurn($)
  expect(summaries).toBe(0)
  expect(commandsOf(calls)).toEqual(['killall'])
  expect(files.size).toBe(0)

  expect(shutdownsOf(calls)).toEqual([])

  const reply = await $.command.run({ command: 'recap', args: 'aç' })
  expect(reply.text).toBe('Bu oturum artık on — özet sesli okunur.')
  expect(spawnsOf(calls).length).toBe(1)
  await finishTurn($)
  expect(summaries).toBe(1)
  expect(commandsOf(calls)).toContain('afplay')
})

test('son verilen komut geçerlidir: hepsi off, sonra bu oturumda on', async ($, on) => {
  const calls: Call[] = []
  const statuses: unknown[] = []
  const files = stubHost(on, new Map(), statuses)
  stubSummary(on)
  stubProcess(on, calls)

  const all = await $.command.run({ command: 'recap', args: 'hepsini kapat' })
  expect(all.text).toBe('Tüm oturumlar artık off — özet yok.')
  expect(JSON.parse(files.get(STATE_PATH) ?? '{}').mode).toBe('off')
  expect(statuses.at(-1)).toBe('recap: off')
  expect(shutdownsOf(calls).length).toBe(1)
  await finishTurn($)
  expect(commandsOf(calls)).not.toContain('afplay')

  const here = await $.command.run({ command: 'recap', args: 'aç' })
  expect(here.text).toBe('Bu oturum artık on — özet sesli okunur.\nDiğer oturumlar off — özet yok.')
  expect(statuses.at(-1)).toBeUndefined()
  await finishTurn($)
  expect(commandsOf(calls)).toContain('afplay')

  const again = await $.command.run({ command: 'recap', args: 'hepsi off' })
  expect(again.text).toBe('Tüm oturumlar artık off — özet yok.')
  expect((await $.command.run({ command: 'recap', args: 'durum' })).text).toBe(
    `Tüm oturumlar off — özet yok.\n${USAGE_LINE}`,
  )
})

test('/recap heryerde sessiz tüm oturumlarda sesi kapatır, özet kalır', async ($, on) => {
  const calls: Call[] = []
  const files = stubHost(on)
  stubSummary(on)
  stubProcess(on, calls)

  const reply = await $.command.run({ command: 'recap', args: 'heryerde sessiz' })
  expect(reply.text).toBe('Tüm oturumlar artık mute — özet yazılır, ses yok.')
  expect(JSON.parse(files.get(STATE_PATH) ?? '{}').mode).toBe('mute')
  await finishTurn($)

  expect(commandsOf(calls)).toEqual(['killall', 'curl'])
  expect(shutdownsOf(calls).length).toBe(1)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: SUMMARY })).toBeDefined()
})

test('başka terminalin yazdığı genel ayar bu oturumda da geçerlidir', async ($, on) => {
  const calls: Call[] = []
  stubHost(on, new Map([[STATE_PATH, '{"mode":"off"}']]))
  stubSummary(on)
  stubProcess(on, calls)

  await finishTurn($)

  expect(calls).toEqual([])
  expect((await $.command.run({ command: 'recap', args: 'durum' })).text).toBe(
    `Tüm oturumlar off — özet yok.\n${USAGE_LINE}`,
  )
})

test('başka terminalden sonra gelen genel ayar bu oturumun eski seçimini geçer', async ($, on) => {
  const calls: Call[] = []
  const files = stubHost(on)
  stubSummary(on)
  stubProcess(on, calls)

  await $.command.run({ command: 'recap', args: 'mute' })
  files.set(STATE_PATH, JSON.stringify({ mode: 'on', at: Date.now() + 60_000 }))
  await finishTurn($)

  expect(commandsOf(calls)).toContain('afplay')
})

test('bozuk durum dosyası sesli özeti engellemez', async ($, on) => {
  const calls: Call[] = []
  stubHost(on, new Map([[STATE_PATH, '{"isMutedForAll":true}']]))
  stubSummary(on)
  stubProcess(on, calls)

  await finishTurn($)

  expect(commandsOf(calls)).toContain('afplay')
})
