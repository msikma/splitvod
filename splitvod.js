#!/usr/bin/env node

const path = require('path')

const PROGRAM = 'splitvod.js'
const VERSION = '0.1.0'

// Durations of a second, a minute, an hour and a day.
const durations = [1000, 1000 * 60, 1000 * 60 * 60, 1000 * 60 * 60 * 24]

// Wraps a string in escape sequences. Used to print the debug table.
const cyan = str => `\u{1b}[36m${str}\u{1b}[0m`
const green = str => `\u{1b}[32m${str}\u{1b}[0m`
const yellow = str => `\u{1b}[33m${str}\u{1b}[0m`
const gray = str => `\u{1b}[90m${str}\u{1b}[0m`

// Maximum display length of filenames in the debug table.
const fnMax = 25

/** Returns the sum of a given set of numbers. */
function add(...args) {
  return args.reduce((all, value) => all + value, 0)
}

/** Converts a DD:HH:MM:SS.MS duration to milliseconds. */
function durationInMs(duration) {
  const [main, remainder] = duration.split('.')
  const values = main.split(':').map(v => parseInt(v))
  const valuesInMs = add(...values.reverse().map((v, n) => v * durations[n]))
  return valuesInMs + parseInt(remainder)
}

/** Converts a millisecond duration to DD:HH:MM:SS.MS format. */
function msToDuration(ms) {
  let res = []
  for (let n = durations.length - 1, m = 0; n >= 0; --n, ++m) {
    const value = Math.floor(ms / durations[n])
    if (!res.length && value === 0) continue
    res.push(value)
    ms -= res[res.length - 1] * durations[n]
  }
  // Join with colon characters, after zero-padding all except the first item.
  const main = res.map((v, n) => n ? String(v).padStart(2, '0') : String(v)).join(':')
  const remainder = ms
  
  return `${main}.${String(remainder).padStart(3, '0')}`
}

/** Converts a video item's duration values to milliseconds. */
function convertDurationsToMs(item = {}) {
  item.start = item.start ? durationInMs(item.start) : null
  item.end = item.end ? durationInMs(item.end) : null
  item.sync = item.sync ? durationInMs(item.sync) : null
  return item
}

/** Adds DD:HH:MM:SS.MS durations to a video item. */
function addDurations(item = {}) {
  item.startDuration = msToDuration(item.start)
  item.endDuration = msToDuration(item.end)
  item.syncDuration = msToDuration(item.sync)
  item.totalDuration = msToDuration(item.end - item.start)
  return item
}

/** Adds a volume value to a video item. */
function addVolume(item = {}) {
  item.vol = item.vol ?? '0.8'
  return item
}

/** Adds a shortened filename value to a video item. */
function addShortenedFilenames(item) {
  const file = path.parse(item.fn)
  const remainder = fnMax - file.ext.length
  if (file.name.length <= remainder) {
    item.fnShort = item.fn
    return item
  }
  const sizeA = Math.round(remainder / 2)
  const sizeB = remainder - sizeA - 1
  const halfA = file.name.slice(0, sizeA)
  const halfB = file.name.slice(file.name.length - sizeB)
  item.fnShort = `${halfA}\u2026${halfB}${file.ext}`
}

/** Calculates the start/end points for 'b' by using the sync points. */
function addStartEndPointsForB(a, b) {
  const startDiff = a.sync - a.start
  const endDiff = a.end - a.sync
  b.start = b.sync - startDiff
  b.end = b.sync + endDiff
  return [a, b]
}

/** Adds default values to the user's options object. */
function addDefaultOptions(options) {
  if (options.leftVideo === 'ab') {
    options.leftVideo = Math.round(Math.random()) ? 'a' : 'b'
  }
  return {
    testDuration: null,
    leftVideo: 'a',
    outputHeight: '720',
    ...options
  }
}

/**
 * Returns a debugging table containing the filenames and start/end timestamps.
 * 
 * Times will be listed in cyan if they've been determined programmatically,
 * and white if they were provided by the user.
 *
 * This also indicates whether we're doing a test encode and other options.
 */
function getDebugTable(a, b, options = {}) {
  const buffer = []
  const header = [
    ['Input files:', fnMax],
    [null, 3, true],
    ['Start:', 14],
    ['Sync:', 14],
    ['End:', 14],
    ['Length:', 14],
    ['Volume:', 8]
  ]
  const leftVideo = options.leftVideo ?? 'a'
  const totalSize = add(...header.map(i => i[1]))
  const separator = header.map(([_, size, isBar]) => `${isBar ? '-+-' : '-'.repeat(size)}`).join('')
  const makeRow = (...items) => items.map((item, n) => `${header[n][2] ? ' | ' : Array.isArray(item) ? item[1](String(item[0]).padEnd(header[n][1])) : String(item).padEnd(header[n][1])}`).join('')
  buffer.push(header.map(([text, size]) => `${(text ?? ' | ').padEnd(size)}`).join(''))
  buffer.push(separator)
  const rowA = makeRow([a.fnShort, green], null, a.startDuration, a.syncDuration, a.endDuration, [a.totalDuration, cyan], a.vol)
  const rowB = makeRow([b.fnShort, green], null, [b.startDuration, cyan], b.syncDuration, [b.endDuration, cyan], [b.totalDuration, cyan], b.vol)
  const rowAB = [rowA, rowB]
  buffer.push(...(options.leftVideo === 'a' ? rowAB : rowAB.reverse()))
  buffer.push(separator)
  if (options.testDuration) {
    buffer.push(makeRow(['Testing duration', yellow], null, '', '', '', [options.testDuration, cyan]))
  }
  return buffer.join('\n')
}

/**
 * Calculates all necessary data for the user's video items.
 *
 * This calculates the start/end positions for the 'b' video item using
 * the given sync points and ensures all default values are set.
 * After this, both items are ready to use with makeEncodeCommands().
 */
function prepareVideoItems(first, second, options = {}) {
  // Our two videos are named 'a' and 'b', with 'a' always being the one
  // that contains start/end positions, and 'b' not having them.
  // We also start off by converting the user's given times to milliseconds.
  const firstA = first.start != null && first.end != null
  const a = convertDurationsToMs(firstA ? first : second)
  const b = convertDurationsToMs(firstA ? second : first)
  
  // If this is a test, we're only using a small portion of the video.
  // This is used to test that the sync points match up correctly.
  if (options.testDuration) {
    a.start = a.sync - (1000 * (options.testDuration / 2))
    a.end = a.sync + (1000 * (options.testDuration / 2))
  }
  
  // Calculate the time between the start/end points and the sync point,
  // and use that to set the start/end points for 'b'.
  addStartEndPointsForB(a, b)
  
  // Ensure all additional information is present.
  addDurations(a)
  addDurations(b)
  addShortenedFilenames(a)
  addShortenedFilenames(b)
  addVolume(a)
  addVolume(b)
  
  return [a, b, options]
}


/**
 * Returns a list of ffmpeg encoding commands to create the final video.
 *
 * This takes two items processed by prepareVideoItems() and returns
 * an array of commands (usually one) that will generate the video when run.
 *
 * It incorporates the following filters:
 *
 *   [v] hstack - horizontally stacks two videos
 *   [v] scale  - ensures both videos are the same height
 *   [v] fade   - adds a fade-in and fade-out to the video
 *   [a] volume - used to even out the volume between both streams
 *   [a] afade  - audio fade in conjunction with the video fade
 */
function makeEncodeCommands(a, b, options) {
  // Whether the 'a' video is on the left side.
  const firstA = options.leftVideo === 'a'
  
  // Search to the start point of each video.
  const vInputA = `-ss "${a.startDuration}" -i "${a.fn}"`
  const vInputB = `-ss "${b.startDuration}" -i "${b.fn}"`
  const vInputAB = (firstA ? [vInputA, vInputB] : [vInputB, vInputA]).join(' ')
  
  // Ensure all streams have the same height and add the fade-in/out filters.
  const vScale = `scale=-1:${options.outputHeight}`
  const vFadeIn = `fade=type=in:duration=1:start_time=0.05`
  const vFadeOut = `fade=type=out:duration=1:start_time=${(a.end - a.start - 1000) / 1000}`
  const vFilters = [vScale, vFadeIn, vFadeOut].join(',')
  
  // Set the volume and fade-in/out filters for each stream.
  const aStreamA = firstA ? '0' : '1'
  const aStreamB = firstA ? '1' : '0'
  const aVolumeA = `volume=${a.vol}`
  const aVolumeB = `volume=${b.vol}`
  const aFadeIn = `afade=type=in:duration=1:start_time=0`
  const aFadeOut = `afade=type=out:duration=1:start_time=${(a.end - a.start - 1000) / 1000}`
  const aFilterA = `[${aStreamA}:a]${[aVolumeA, aFadeIn, aFadeOut].join(',')}[a${aStreamA}]`
  const aFilterB = `[${aStreamB}:a]${[aVolumeB, aFadeOut, aFadeOut].join(',')}[a${aStreamB}]`
  const aFilterAB = [aFilterA, aFilterB].join(';')
  
  // Put everything together into a single command.
  return [`ffmpeg -y ${vInputAB} -t "${a.totalDuration}" -filter_complex "[0:v]${vFilters}[v0];[1:v]${vFilters}[v1];[v0][v1]hstack=inputs=2[v];${aFilterAB};[a0][a1]amerge=inputs=2[a]" -map "[v]" -map "[a]" -ac 2 "out.mp4"`]
}

/**
 * Prints a usage description if the user passes --help or an invalid option.
 */
function printUsage(error) {
  const header = `
usage: ${PROGRAM} [-h] [-v] [--left-video N] [--output-height PIXELS] [--test]
       ${' '.repeat(PROGRAM.length)} -a FILE SYNC START END [VOL] -b FILE SYNC [VOL]
`.trim()
  if (error) {
    console.log(`
${header}

${PROGRAM}: error: ${error === true ? 'Invalid arguments.' : error}
`.trim())
    process.exit(1)
  }
  console.log(`
${header}

Generates ffmpeg commands for creating a split FPVOD.

arguments:
  -h, --help              show this help message and exit
  -v, --version           show program's version number and exit
  --left-video {A,B,AB}   whether A/B is on the left side (default: AB [random])
  --output-height PIXELS  which height to use for the output (default: 1080)
  --test                  whether to enable sync test (only 15 secs encode)

video information:
  -a FILE SYNC START END [VOL]  filename, sync, start/end and volume data for A
  -b FILE SYNC [VOL]            filename, sync and volume data for B

example:
  ${PROGRAM} -a "stream1.mp4" "3:53:16.082" "3:50:59.214" "4:05:51.942" "0.2" \\
  ${' '.repeat(PROGRAM.length)} -b "stream2.mp4" "2:29:00.976" "0.8"
`.trim())
  process.exit(0)
}

/**
 * Prints out the program version.
 */ 
function printVersion() {
  console.log(`${PROGRAM}: ${VERSION}`)
  process.exit(0)
}

/**
 * Parses command-line arguments.
 *
 * Will exit the program if invalid arguments were passed.
 */
function parseArguments(args) {
  if (args.includes('-h') || args.includes('--help')) {
    return printUsage()
  }
  if (args.includes('-v') || args.includes('--version')) {
    return printVersion()
  }
  if (!args.includes('-a') || !args.includes('-b')) {
    return printUsage(true)
  }
  
  // Helper function for finding the index of a particular argument.
  const findIndex = str => {
    const idx = args.findIndex(arg => arg === str)
    if (idx === -1) return undefined
    return idx
  }
  
  // Check for unknown arguments.
  const validOpts = ['h', 'help', 'v', 'version', 'a', 'b', 'left-video', 'output-height', 'test']
  const invalidOpts = args.map(arg => arg.match(/-+(.+?)$/)?.[1])
    .filter(arg => arg)
    .filter(arg => !validOpts.includes(arg))
  
  if (invalidOpts.length) {
    return printUsage(`Unknown options: ${invalidOpts.join(', ')}.`)
  }
  
  // Find the arguments passed to -a and -b.
  const idxA = findIndex('-a')
  const idxB = findIndex('-b')
  const endB = args.findIndex((arg, n) => n > idxB && arg.startsWith('-'))
  const argsA = args.slice(idxA + 1, idxB)
  const argsB = args.slice(idxB + 1, endB === -1 ? undefined : endB)
  
  // Find other options that may have been set.
  const idxLeftVideo = findIndex('--left-video')
  const idxOutputHeight = findIndex('--output-height')
  const idxTest = findIndex('--test')
  
  const leftVideo = String(args[idxLeftVideo + 1] || 'ab').toLowerCase()
  const outputHeight = String(args[idxOutputHeight + 1] || '1080')
  const isTest = !!args[idxTest]

  if (leftVideo.includes('-') || outputHeight.includes('-')) {
    return printUsage(true)
  }
  if (String(Number(outputHeight)) !== outputHeight) {
    return printUsage('The value of --output-height must be numeric.')
  }
  
  // Collect all arguments we received and return them as video objects.
  const [fnA, syncA, startA, endA, volA] = argsA
  const [fnB, syncB, volB] = argsB
  const videoA = {
    fn: fnA,
    sync: syncA,
    start: startA,
    end: endA,
    vol: volA
  }
  const videoB = {
    fn: fnB,
    sync: syncB,
    vol: volB
  }
  const testOptions = isTest ? {testDuration: 15} : {}
  
  return [videoA, videoB, {leftVideo, outputHeight, ...testOptions}]
}

/**
 * Script main entry point.
 *
 * Parses command-line arguments and generates ffmpeg commands.
 */
function main(argv) {
  const [videoA, videoB, userOptions] = parseArguments(argv.slice(2))
  if (!videoA || !videoB) {
    console.error(`${PROGRAM}: error: Missing information about input files.`)
    process.exit(1)
  }
  const [a, b, options] = prepareVideoItems(videoA, videoB, addDefaultOptions(userOptions))
  const cmds = makeEncodeCommands(a, b, options)
  
  console.log(getDebugTable(a, b, options))
  console.log('')
  cmds.forEach(cmd => console.log(cmd))
}

// Start the script with passed command-line arguments.
main(process.argv)
