const path = require('path')
const zlib = require('zlib')

function normalizePhoneNumber(value) {

  const digits =
    String(value || '').replace(/\D/g, '')

  if (/^233\d{9}$/.test(digits)) {
    return digits
  }

  if (/^0\d{9}$/.test(digits)) {
    return `233${digits.slice(1)}`
  }

  if (/^\d{9}$/.test(digits)) {
    return `233${digits}`
  }

  if (digits.length >= 7 && digits.length <= 15) {
    return digits
  }

  return null
}

function extractContactCandidates(text) {

  return String(text || '')
    .split(/[\s,;|]+/)
    .map(value => value.trim())
    .filter(Boolean)
}

function validateContactsFromText(text) {

  const candidates =
    extractContactCandidates(text)

  const contacts = []
  const seen = new Set()
  const duplicates = []
  const invalid = []

  candidates.forEach(candidate => {

    const normalized =
      normalizePhoneNumber(candidate)

    if (!normalized) {
      invalid.push(candidate)
      return
    }

    if (seen.has(normalized)) {
      duplicates.push(normalized)
      return
    }

    seen.add(normalized)
    contacts.push(normalized)
  })

  return {
    contacts,
    duplicates,
    invalid,
    totalCandidates: candidates.length
  }
}

function decodeXml(value) {

  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function stripXmlTags(value) {

  return decodeXml(
    String(value || '').replace(/<[^>]+>/g, ' ')
  )
}

function readZipEntries(buffer) {

  const entries = {}
  let endOfCentralDirectoryOffset = -1

  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOfCentralDirectoryOffset = offset
      break
    }
  }

  if (endOfCentralDirectoryOffset === -1) {
    throw new Error('Invalid Excel file.')
  }

  const entryCount =
    buffer.readUInt16LE(endOfCentralDirectoryOffset + 10)
  let centralDirectoryOffset =
    buffer.readUInt32LE(endOfCentralDirectoryOffset + 16)

  for (let index = 0; index < entryCount; index += 1) {

    const signature =
      buffer.readUInt32LE(centralDirectoryOffset)

    if (signature !== 0x02014b50) {
      break
    }

    const compression =
      buffer.readUInt16LE(centralDirectoryOffset + 10)
    const compressedSize =
      buffer.readUInt32LE(centralDirectoryOffset + 20)
    const fileNameLength =
      buffer.readUInt16LE(centralDirectoryOffset + 28)
    const extraLength =
      buffer.readUInt16LE(centralDirectoryOffset + 30)
    const commentLength =
      buffer.readUInt16LE(centralDirectoryOffset + 32)
    const localHeaderOffset =
      buffer.readUInt32LE(centralDirectoryOffset + 42)
    const fileName =
      buffer
        .slice(
          centralDirectoryOffset + 46,
          centralDirectoryOffset + 46 + fileNameLength
        )
        .toString('utf8')

    const localFileNameLength =
      buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraLength =
      buffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart =
      localHeaderOffset + 30 + localFileNameLength + localExtraLength
    const dataEnd =
      dataStart + compressedSize
    const compressed =
      buffer.slice(dataStart, dataEnd)

    if (compression === 0) {
      entries[fileName] = compressed.toString('utf8')
    } else if (compression === 8) {
      entries[fileName] =
        zlib.inflateRawSync(compressed).toString('utf8')
    }

    centralDirectoryOffset +=
      46 + fileNameLength + extraLength + commentLength
  }

  return entries
}

function extractTextFromXlsx(buffer) {

  const entries =
    readZipEntries(buffer)

  const sharedStrings = []
  const sharedStringsXml =
    entries['xl/sharedStrings.xml']

  if (sharedStringsXml) {
    const stringMatches =
      sharedStringsXml.match(/<si[\s\S]*?<\/si>/g) || []

    stringMatches.forEach(item => {
      sharedStrings.push(stripXmlTags(item))
    })
  }

  return Object.entries(entries)
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .map(([, xml]) => {
      return xml.replace(/<c[^>]*t="s"[^>]*>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>/g, (_match, index) => {
        return ` ${sharedStrings[Number(index)] || ''} `
      })
    })
    .map(stripXmlTags)
    .join('\n')
}

function extractContactsFromFile(fileName, buffer) {

  const extension =
    path.extname(fileName || '').toLowerCase()

  if (extension === '.xlsx') {
    return validateContactsFromText(extractTextFromXlsx(buffer))
  }

  if (['.txt', '.csv', '.tsv'].includes(extension)) {
    return validateContactsFromText(buffer.toString('utf8'))
  }

  throw new Error('Unsupported file type. Upload .xlsx, .csv, .tsv, or .txt.')
}

module.exports = {
  extractContactsFromFile,
  validateContactsFromText
}
