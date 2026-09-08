/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { pipeline } from 'stream/promises'
import { LoggerOptions } from '.'

enum LogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
  FATAL = 5,
}

class Logger {
  private level: LogLevel = LogLevel.INFO
  private logDir = './logs'
  private currentLogFile = 'latest.log'
  private maxFileSize = 1024 * 1024 // 1MB
  private maxRetentionDays = 7 // Keep logs for 7 days
  private writeStream: fs.WriteStream | null = null
  private currentFileSize = 0
  private isRotating = false
  private rotationBuffer: string[] = []
  private activeCompressions = 0

  constructor(options?: LoggerOptions) {
    if (options?.logDir) this.logDir = options.logDir
    if (options?.maxFileSize) this.maxFileSize = options.maxFileSize
    if (options?.maxRetentionDays) this.maxRetentionDays = options.maxRetentionDays

    this.initLogDir()
    this.openLogFile()
  }

  public async waitForTasks(): Promise<void> {
    while (this.isRotating || this.rotationBuffer.length > 0 || this.activeCompressions > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // Ensure write stream is drained and closed
    if (this.writeStream) {
      await new Promise<void>((resolve) => {
        if (this.writeStream) {
          this.writeStream.end(resolve)
        } else {
          resolve()
        }
      })
      this.writeStream = null
    }
  }

  private initLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true })
    }
  }

  private openLogFile() {
    const filePath = path.join(this.logDir, this.currentLogFile)
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath)
      this.currentFileSize = stats.size
    } else {
      this.currentFileSize = 0
    }
    this.writeStream = fs.createWriteStream(filePath, { flags: 'a' })
  }

  public setLevel(level: LogLevel): void {
    this.level = level
  }

  public getLevel(): LogLevel {
    return this.level
  }

  private getTimestamp(): string {
    return new Date().toISOString()
  }

  private getColor(level: LogLevel): string {
    switch (level) {
      case LogLevel.FATAL:
        return '\x1b[35m' // Magenta
      case LogLevel.ERROR:
        return '\x1b[31m' // Red
      case LogLevel.WARN:
        return '\x1b[33m' // Yellow
      case LogLevel.INFO:
        return '\x1b[34m' //Blue
      case LogLevel.DEBUG:
        return '\x1b[32m' // Green
      case LogLevel.TRACE:
        return '\x1b[90m' // Gray
      default:
        return '\x1b[37m' // White
    }
  }

  public async log(name: string, level: LogLevel, message: string, args: any[]): Promise<void> {
    const timestamp = this.getTimestamp()
    const color = this.getColor(level)
    const resetColor = '\x1b[0m'
    const levelName = LogLevel[level].padEnd(5)

    // Console output (with colors) - Only if level meets threshold
    if (level >= this.level) {
      const consoleMessage = `${color}[${timestamp}] [${levelName}] [${name}] ${message}${resetColor}`
      if (level >= LogLevel.ERROR) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        console.error(consoleMessage, ...args)
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        console.log(consoleMessage, ...args)
      }
    }

    // File output (without colors) - Always write to file
    let fileMessage = `[${timestamp}] [${levelName}] [${name}] ${message}`
    if (args.length > 0) {
      fileMessage +=
        ' ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    }
    await this.writeToFile(fileMessage)
  }

  private async writeToFile(message: string): Promise<void> {
    if (this.isRotating) {
      this.rotationBuffer.push(message)
      return
    }

    const buffer = Buffer.from(message + '\n')

    if (this.currentFileSize + buffer.length > this.maxFileSize) {
      this.rotationBuffer.push(message)
      await this.rotateLog()
      return
    }

    if (this.writeStream && this.writeStream.writable) {
      this.writeStream.write(buffer)
      this.currentFileSize += buffer.length
    }
  }

  private async rotateLog(): Promise<void> {
    if (this.isRotating) return
    this.isRotating = true

    try {
      while (true) {
        if (this.writeStream) {
          await new Promise<void>((resolve) => {
            if (this.writeStream) {
              this.writeStream.end(resolve)
            } else {
              resolve()
            }
          })
          this.writeStream = null
        }

        const dateStr = new Date().toISOString().split('T')[0]
        let counter = 1

        // Find next available counter asynchronously
        while (true) {
          const gzPath = path.join(this.logDir, `${dateStr}.${counter}.log.gz`)
          const logPath = path.join(this.logDir, `${dateStr}.${counter}.log`)

          try {
            await fs.promises.access(gzPath)
            counter++
            continue
          } catch {
            // No existing gz file, check for log file
          }

          try {
            await fs.promises.access(logPath)
            counter++
            continue
          } catch {
            // No existing file, we can use this counter
          }

          break
        }

        const archiveName = `${dateStr}.${counter}.log`
        const archivePath = path.join(this.logDir, archiveName)
        const currentPath = path.join(this.logDir, this.currentLogFile)

        try {
          if (fs.existsSync(currentPath)) {
            await fs.promises.rename(currentPath, archivePath)
            // Start compression in background
            this.compressFile(archivePath)
          }
        } catch (e) {
          // If rename fails (e.g. file missing), we might want to just recreate it
          // But for now let's log and continue to openLogFile
          console.error('Error renaming log file:', e)
        }

        // Re-open log file
        this.openLogFile()

        // Flush buffer
        let needRotateAgain = false
        while (this.rotationBuffer.length > 0) {
          const msg = this.rotationBuffer[0]
          const buffer = Buffer.from(msg + '\n')

          if (this.currentFileSize + buffer.length > this.maxFileSize) {
            needRotateAgain = true
            break
          }

          this.rotationBuffer.shift()
          // TypeScript flow analysis issue workaround
          const stream = this.writeStream as fs.WriteStream | null
          if (stream && stream.writable) {
            stream.write(buffer)
            this.currentFileSize += buffer.length
          }
        }

        if (!needRotateAgain) {
          break
        }
      }
    } catch (e) {
      console.error('Failed to rotate log:', e)
    } finally {
      this.isRotating = false
    }
  }

  private async compressFile(filePath: string) {
    this.activeCompressions++
    try {
      const gzip = zlib.createGzip()
      const source = fs.createReadStream(filePath)
      const destination = fs.createWriteStream(`${filePath}.gz`)

      await pipeline(source, gzip, destination)

      await fs.promises.unlink(filePath)
      await this.cleanUpOldFiles()
    } catch (err) {
      console.error('Compression failed:', err)
    } finally {
      this.activeCompressions--
    }
  }

  private async cleanUpOldFiles() {
    try {
      const files = await fs.promises.readdir(this.logDir)
      const archives = files.filter((f) => f.endsWith('.log.gz'))

      const now = new Date()
      const retentionMs = this.maxRetentionDays * 24 * 60 * 60 * 1000

      for (const file of archives) {
        const parts = file.split('.')
        // Filename format: YYYY-MM-DD.N.log.gz
        const dateStr = parts[0]
        if (!dateStr) continue
        const fileDate = new Date(dateStr)

        if (isNaN(fileDate.getTime())) continue

        if (now.getTime() - fileDate.getTime() > retentionMs) {
          try {
            await fs.promises.unlink(path.join(this.logDir, file))
          } catch (e) {
            console.error(`Failed to delete old log file ${file}:`, e)
          }
        }
      }
    } catch (err) {
      console.error('Failed to clean up old files:', err)
    }
  }
}

class NamedLogger {
  constructor(
    private name: string,
    private logger: Logger,
  ) {}

  public async trace(message: string, ...args: any[]): Promise<void> {
    await this.logger.log(this.name, LogLevel.TRACE, message, args)
  }

  public async debug(message: string, ...args: any[]): Promise<void> {
    await this.logger.log(this.name, LogLevel.DEBUG, message, args)
  }

  public async info(message: string, ...args: any[]): Promise<void> {
    await this.logger.log(this.name, LogLevel.INFO, message, args)
  }

  public log = this.info

  public async warn(message: string, ...args: any[]): Promise<void> {
    await this.logger.log(this.name, LogLevel.WARN, message, args)
  }

  public async error(message: string, ...args: any[]): Promise<void> {
    await this.logger.log(this.name, LogLevel.ERROR, message, args)
  }

  public async fatal(message: string, ...args: any[]): Promise<void> {
    await this.logger.log(this.name, LogLevel.FATAL, message, args)
  }
}

const rootLogger = new Logger()

export const log = {
  getLogger: (name: string) => new NamedLogger(name, rootLogger),
  stop: () => rootLogger.waitForTasks(),
}
