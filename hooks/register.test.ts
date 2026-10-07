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
const PROOF = 'kanit'

const MAC_ENV = { HOME: '/home/test' }
const MAC_STATE_PATH = '/home/test/.claude/recap.json'
const MAC_VOICE_DIR = '/home/test/.claude/recap'
const MAC_SOCKET = '/home/test/.claude/recap/voice.sock'
const MAC_PYTHON = '/home/test/.local/share/recap-ema/bin/python'

const WIN_ENV = { OS: 'Windows_NT', USERPROFILE: '/win/Users/test', HOME: '/shared/home' }
const WIN_STATE_PATH = '/win/Users/test/.claude/recap.json'
const WIN_VOICE_DIR = '/win/Users/test/.claude/recap'
const WIN_ENDPOINT_PATH = '/win/Users/test/.claude/recap/voice.json'
const WIN_PYTHON = '/win/Users/test/.local/share/recap-ema/Scripts/python.exe'
const WIN_ENDPOINT = JSON.stringify({ port: 51234, token: 'jeton', proof: PROOF, pid: 42 })

type Call = { argv: readonly string[]; stdin?: string }

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const finished = (stdout = '', exitCode = 0) =>
  ({ value: { exitCode, stdout, stderr: '' } }) as never

const stubHost = (
  on: On,
  {
    files = new Map<string, string>(),
    statuses = [] as unknown[],
    env = MAC_ENV as Record<string, string>,
  } = {},
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

const endpointOf = (argv: readonly string[]) => argv.at(-1)?.split('/').at(-1)

const answer = (code: string, proof = PROOF) =>
  code === '000' ? finished('\n000', 7) : finished(`${proof}\n${code}`)

const stubProcess = (
  on: On,
  calls: Call[],
  {
    speakAnswers = [] as string[],
    speakDefault = '200',
    proof = PROOF,
    slowSpeakMs = 0,
    onSpawn = () => {},
  } = {},
) =>
  on('process.run', async (_$, e) => {
    const [command = ''] = e.argv
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    if (command === 'curl' && endpointOf(e.argv) === 'speak') {
      await pause(slowSpeakMs)
      return answer(speakAnswers.shift() ?? speakDefault, proof)
    }
    if (command === 'curl') return answer('200', proof)
    if (command.endsWith('python') || command.endsWith('python.exe')) onSpawn()
    return finished()
  })

const finishTurn = async ($: Engine, answerText = LONG_ANSWER) => {
  await $.turn.complete({ ...turn, answer: answerText, reason: 'answer' })
  await pause(60)
}

const commandsOf = (calls: Call[]) => calls.map(call => call.argv[0])

const requestsTo = (calls: Call[], endpoint: string) =>
  calls.filter(call => call.argv[0] === 'curl' && endpointOf(call.argv) === endpoint)

const spawnsOf = (calls: Call[]) =>
  calls.filter(call => call.argv[0] === MAC_PYTHON || call.argv[0] === WIN_PYTHON)

const valueAfter = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1]

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

test('uzun cevap özetlenir ve sunucuya okutulur; eklenti ses dosyası ya da oynatıcı çalıştırmaz', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls)

  await finishTurn($)

  const [speak] = requestsTo(calls, 'speak')
  expect(JSON.parse(speak?.stdin ?? '{}')).toEqual({ text: SUMMARY })
  expect(valueAfter(speak?.argv ?? [], '--unix-socket')).toBe(MAC_SOCKET)
  expect(speak?.argv.at(-1)).toBe('http://localhost/speak')
  expect(commandsOf(calls)).toEqual(['curl'])
  expect(spawnsOf(calls)).toEqual([])
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
  expect(JSON.parse(requestsTo(calls, 'speak')[0]?.stdin ?? '{}')).toEqual({ text: 'Tamam, bitti.' })
})

test('ses sunucusu kapalıysa eklenti onu başlatır ve bir kez daha dener', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { speakAnswers: ['000', '200'] })

  await finishTurn($)

  const [spawn] = spawnsOf(calls)
  expect(spawn?.argv[1]).toBe('-I')
  expect(spawn?.argv[2]).toMatch(/\/tts\/ema_server\.py$/)
  expect(spawn?.argv.slice(3)).toEqual(['--dir', MAC_VOICE_DIR, '--detach'])
  expect(requestsTo(calls, 'speak').length).toBe(2)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: SUMMARY })).toBeDefined()
})

test('sunucu başlatılamazsa ses çıkmaz, özet yalnız ekranda kalır', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { speakDefault: '000' })

  await finishTurn($)

  expect(spawnsOf(calls).length).toBe(1)
  expect(requestsTo(calls, 'speak').length).toBe(2)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: `Ses üretilemedi, sesli okunmadı. ${SUMMARY}` })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'close' })).toBeDefined()
})

test('makine yoğunsa sunucu 503 der, özet yalnız ekranda kalır', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { speakAnswers: ['503'] })

  await finishTurn($)

  expect(spawnsOf(calls)).toEqual([])
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: `Makine yoğun, sesli okunmadı. ${SUMMARY}` })).toBeDefined()
})

test('recap olmayan bir cevap sunucu yok sayılır', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { speakAnswers: ['404', '200'] })

  await finishTurn($)

  expect(spawnsOf(calls).length).toBe(1)
  expect(requestsTo(calls, 'speak').length).toBe(2)
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

test('Sustur düğmesi sunucuya durdurma gönderir ve özet ekranda kalır', async ($, on) => {
  const calls: Call[] = []
  stubHost(on)
  stubSummary(on)
  stubProcess(on, calls, { slowSpeakMs: 400 })

  await finishTurn($)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: SUMMARY })).toBeDefined()

  await band.press({ key: 'stop' })

  expect(requestsTo(calls, 'stop').length).toBe(1)
  expect(await band.find({ type: 'Button', key: 'close' })).toBeDefined()
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

test('Windows: sunucuya voice.json içindeki port ve jetonla gidilir', async ($, on) => {
  const calls: Call[] = []
  stubHost(on, { env: WIN_ENV, files: new Map([[WIN_ENDPOINT_PATH, WIN_ENDPOINT]]) })
  stubSummary(on)
  stubProcess(on, calls)

  await finishTurn($)

  const [speak] = requestsTo(calls, 'speak')
  expect(speak?.argv.at(-1)).toBe('http://127.0.0.1:51234/speak')
  expect(valueAfter(speak?.argv ?? [], '-H')).toBe('Content-Type: application/json')
  expect(speak?.argv).toContain('X-Recap-Token: jeton')
  expect(speak?.argv).not.toContain('--unix-socket')
  expect(spawnsOf(calls)).toEqual([])
})

test('Windows: voice.json yoksa sunucu USERPROFILE altındaki Python ile başlatılır', async ($, on) => {
  const calls: Call[] = []
  const files = stubHost(on, { env: WIN_ENV })
  stubSummary(on)
  stubProcess(on, calls, { onSpawn: () => files.set(WIN_ENDPOINT_PATH, WIN_ENDPOINT) })

  await finishTurn($)

  expect(spawnsOf(calls)[0]?.argv.slice(3)).toEqual(['--dir', WIN_VOICE_DIR, '--detach'])
  expect(requestsTo(calls, 'speak').length).toBe(1)
  expect(requestsTo(calls, 'speak')[0]?.argv.at(-1)).toBe('http://127.0.0.1:51234/speak')
})

test('Windows: özet, sunucu kendini kanıtlamadan gönderilmez', async ($, on) => {
  const calls: Call[] = []
  stubHost(on, { env: WIN_ENV, files: new Map([[WIN_ENDPOINT_PATH, WIN_ENDPOINT]]) })
  stubSummary(on)
  stubProcess(on, calls, { proof: 'baska-bir-program' })

  await finishTurn($)

  expect(requestsTo(calls, 'hello').length).toBe(2)
  expect(requestsTo(calls, 'speak')).toEqual([])
  expect(calls.some(call => call.stdin?.includes(SUMMARY))).toBe(false)
  expect(spawnsOf(calls).length).toBe(1)
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: `Ses üretilemedi, sesli okunmadı. ${SUMMARY}` })).toBeDefined()
})

test('Windows: kendini kanıtlayan sunucuya özet gönderilir', async ($, on) => {
  const calls: Call[] = []
  stubHost(on, { env: WIN_ENV, files: new Map([[WIN_ENDPOINT_PATH, WIN_ENDPOINT]]) })
  stubSummary(on)
  stubProcess(on, calls)

  await finishTurn($)

  const [hello] = requestsTo(calls, 'hello')
  expect(hello?.stdin).toBeUndefined()
  expect(hello?.argv).toContain('X-Recap-Token: jeton')
  expect(calls.findIndex(call => endpointOf(call.argv) === 'hello')).toBeLessThan(
    calls.findIndex(call => endpointOf(call.argv) === 'speak'),
  )
})

test('Windows: genel durum dosyası HOME değil USERPROFILE altında tutulur', async ($, on) => {
  const calls: Call[] = []
  const files = stubHost(on, { env: WIN_ENV })
  stubProcess(on, calls)

  await $.command.run({ command: 'recap', args: 'hepsi off' })

  expect(JSON.parse(files.get(WIN_STATE_PATH) ?? '{}').mode).toBe('off')
  expect([...files.keys()].some(path => path.startsWith('/shared'))).toBe(false)
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
  expect(calls).toEqual([])

  await finishTurn($)
  expect(requestsTo(calls, 'speak').length).toBe(1)
})

test('/recap mute bu oturumun sesini kapatır, özet yine ekranda görünür', async ($, on) => {
  const calls: Call[] = []
  const statuses: unknown[] = []
  const files = stubHost(on, { statuses })
  stubSummary(on)
  stubProcess(on, calls)

  const reply = await $.command.run({ command: 'recap', args: 'mute' })
  expect(reply.text).toBe(
    'Bu oturum artık mute — özet yazılır, ses yok.\nDiğer oturumlar on — özet sesli okunur.',
  )
  expect(statuses.at(-1)).toBe('recap: mute')
  await finishTurn($)

  expect(requestsTo(calls, 'speak')).toEqual([])
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

test('/recap off bu oturumda özeti kapatır, /recap on geri açar ve sunucuyu ısıtır', async ($, on) => {
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
  expect(calls).toEqual([])
  expect(files.size).toBe(0)

  const reply = await $.command.run({ command: 'recap', args: 'aç' })
  expect(reply.text).toBe('Bu oturum artık on — özet sesli okunur.')
  expect(spawnsOf(calls).length).toBe(1)
  await finishTurn($)
  expect(summaries).toBe(1)
  expect(requestsTo(calls, 'speak').length).toBe(1)
})

test('son verilen komut geçerlidir: hepsi off sunucuyu kapatır, sonra bu oturumda on', async ($, on) => {
  const calls: Call[] = []
  const statuses: unknown[] = []
  const files = stubHost(on, { statuses })
  stubSummary(on)
  stubProcess(on, calls)

  const all = await $.command.run({ command: 'recap', args: 'hepsini kapat' })
  expect(all.text).toBe('Tüm oturumlar artık off — özet yok.')
  expect(JSON.parse(files.get(MAC_STATE_PATH) ?? '{}').mode).toBe('off')
  expect(statuses.at(-1)).toBe('recap: off')
  expect(requestsTo(calls, 'shutdown').length).toBe(1)
  await finishTurn($)
  expect(requestsTo(calls, 'speak')).toEqual([])

  const here = await $.command.run({ command: 'recap', args: 'aç' })
  expect(here.text).toBe('Bu oturum artık on — özet sesli okunur.\nDiğer oturumlar off — özet yok.')
  expect(statuses.at(-1)).toBeUndefined()
  await finishTurn($)
  expect(requestsTo(calls, 'speak').length).toBe(1)

  const again = await $.command.run({ command: 'recap', args: 'hepsi off' })
  expect(again.text).toBe('Tüm oturumlar artık off — özet yok.')
  expect((await $.command.run({ command: 'recap', args: 'durum' })).text).toBe(
    `Tüm oturumlar off — özet yok.\n${USAGE_LINE}`,
  )
})

test('/recap heryerde sessiz tüm oturumlarda sesi kapatır, sunucuyu kapatır, özet kalır', async ($, on) => {
  const calls: Call[] = []
  const files = stubHost(on)
  stubSummary(on)
  stubProcess(on, calls)

  const reply = await $.command.run({ command: 'recap', args: 'heryerde sessiz' })
  expect(reply.text).toBe('Tüm oturumlar artık mute — özet yazılır, ses yok.')
  expect(JSON.parse(files.get(MAC_STATE_PATH) ?? '{}').mode).toBe('mute')
  await finishTurn($)

  expect(requestsTo(calls, 'shutdown').length).toBe(1)
  expect(requestsTo(calls, 'speak')).toEqual([])
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: SUMMARY })).toBeDefined()
})

test('başka terminalin yazdığı genel ayar bu oturumda da geçerlidir', async ($, on) => {
  const calls: Call[] = []
  stubHost(on, { files: new Map([[MAC_STATE_PATH, '{"mode":"off"}']]) })
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
  files.set(MAC_STATE_PATH, JSON.stringify({ mode: 'on', at: Date.now() + 60_000 }))
  await finishTurn($)

  expect(requestsTo(calls, 'speak').length).toBe(1)
})

test('bozuk durum dosyası sesli özeti engellemez', async ($, on) => {
  const calls: Call[] = []
  stubHost(on, { files: new Map([[MAC_STATE_PATH, '{"isMutedForAll":true}']]) })
  stubSummary(on)
  stubProcess(on, calls)

  await finishTurn($)

  expect(requestsTo(calls, 'speak').length).toBe(1)
})
