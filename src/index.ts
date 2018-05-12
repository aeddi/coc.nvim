// umask is blacklisted by node-client
process.umask = ()=> {
  return 18
}
import { Plugin, Autocmd, Function, Neovim } from 'neovim'
import {
  SourceStat,
  CompleteOption,
  VimCompleteItem} from './types'
import {
  wait,
  echoErr,
  contextDebounce} from './util/index'
import {
  setConfig,
  toggleSource,
  configSource,
  getConfig} from './config'
import debounce = require('debounce')
import buffers from './buffers'
import completes from './completes'
import remotes from './remotes'
import natives from './natives'
import remoteStore from './remote-store'
import increment from './increment'
import Input from './input'
const logger = require('./util/logger')('index')

@Plugin({dev: true})
export default class CompletePlugin {
  public nvim: Neovim
  private debouncedOnChange: (bufnr: string)=>void

  constructor(nvim: Neovim) {
    this.nvim = nvim
    this.debouncedOnChange = contextDebounce((bufnr: string) => {
      this.onBufferChange(bufnr).catch(e => {
        logger.error(e.message)
      })
      logger.debug(`buffer ${bufnr} change`)
    }, 500)

    process.on('unhandledRejection', (reason, p) => {
      logger.error('Unhandled Rejection at:', p, 'reason:', reason)
      if (reason instanceof Error) this.handleError(reason)
    })
    process.on('uncaughtException', this.handleError)
  }

  private handleError(err: Error):void {
    let {nvim} = this
    echoErr(nvim ,`Service error: ${err.message}`).catch(err => {
      logger.error(err.message)
    })
  }

  @Autocmd('VimEnter', {
    sync: false,
    pattern: '*'
  })
  public async onVimEnter(): Promise<void> {
    let {nvim} = this
    try {
      await this.initConfig()
      await natives.init()
      await remotes.init(nvim, natives.names)
      await nvim.command(`let g:coc_node_channel_id=${(nvim as any)._channel_id}`)
      await nvim.command('silent doautocmd User CocNvimInit')
      logger.info('Complete service Initailized')
      // required since BufRead triggered before VimEnter
      let bufs:number[] = await nvim.call('coc#util#get_buflist', [])
      for (let buf of bufs) {
        await buffers.addBuffer(nvim, buf.toString())
      }
    } catch (err) {
      logger.error(err.stack)
      return echoErr(nvim, `Initailize failed, ${err.message}`)
    }
  }

  @Function('CocBufUnload', {sync: false})
  public async cocBufUnload(args: any[]):Promise<void> {
    let bufnr = args[0].toString()
    buffers.removeBuffer(bufnr)
    logger.debug(`buffer ${bufnr} remove`)
  }

  @Function('CocBufChange', {sync: false})
  public async cocBufChange(args: any[]):Promise<void> {
    let bufnr = args[0].toString()
    this.debouncedOnChange(bufnr)
  }

  @Function('CocStart', {sync: false})
  public async cocStart(args: [CompleteOption]):Promise<void> {
    let opt = args[0]
    let start = Date.now()
    let {nvim} = this
    logger.debug(`options: ${JSON.stringify(opt)}`)
    let {filetype, col, linenr} = opt
    let complete = completes.createComplete(opt)
    let sources = await completes.getSources(nvim, filetype)
    complete.doComplete(sources).then(async ([startcol, items])=> {
      if (items.length == 0) {
        // no items found
        completes.reset()
        return
      }
      if (items.length > 1) {
        increment.setOption(opt)
      }
      let first = items[0]
      nvim.setVar('coc#_context', {
        start: startcol,
        candidates: items
      })
      nvim.call('coc#_do_complete', []).then(() => {
        logger.debug(`Complete time cost: ${Date.now() - start}ms`)
      })
      if (items.length> 1) {
        await wait(50)
        let visible = await nvim.call('pumvisible')
        if (visible == 1) {
          let firstWord = first.word
          let len = firstWord.length
          let [_, lnum, col] = await nvim.call('getpos', ['.'])
          if (lnum != linenr) return
          let word = await nvim.call('coc#util#get_insertedword', [col, len])
          if (word == firstWord) {
            let input = new Input(nvim, lnum, opt.input, word, opt.col)
            increment.input = input
            input.highlight()
            // TODO remove this if there's TextChangedP
            let interval = setInterval(() => {
              nvim.call('getline', ['.']).then(line => {
                let word = line.slice(col - len - 1, col - 1)
                if (word !== firstWord) {
                  input.clear()
                  clearInterval(interval)
                }
              }, () => {
                input.clear()
                clearInterval(interval)
              })
            }, 500)
            setTimeout(() => {
              input.clear()
              clearInterval(interval)
            }, 3000)
          }
        }
      }
    })
  }

  @Autocmd('InsertCharPre', {
    pattern: '*',
    sync: true,
  })
  public async cocCharInsert():Promise<void> {
    await increment.onCharInsert(this.nvim)
  }

  @Autocmd('CompleteDone', {
    pattern: '*',
    sync: true,
  })
  public async cocDone():Promise<void> {
    await increment.onComplete(this.nvim)
  }

  @Autocmd('InsertLeave', {
    pattern: '*',
    sync: true,
  })
  public async cocLeave():Promise<void> {
    await increment.stop(this.nvim)
  }

  @Autocmd('TextChangedI', {
    pattern: '*',
    sync: true
  })
  public async cocTextChangeI():Promise<void> {
    let {complete} = completes
    let {nvim} = this
    if (!complete) return
    let shouldStart = await increment.onTextChangeI(nvim)
    if (shouldStart) {
      if (!increment.activted) return
      let {input, option, changedI} = increment
      let opt = Object.assign({}, option, {
        changedtick: changedI.changedtick,
        input: input.input
      })
      let oldComplete = completes.complete || ({} as {[index:string]:any})
      let {results} = oldComplete
      if (!results || results.length == 0) {
        await increment.stop(nvim)
        return
      }

      let start = Date.now()
      logger.debug(`Resume options: ${JSON.stringify(opt)}`)
      let {startcol, icase} = oldComplete
      let complete = completes.newComplete(opt)
      let items = complete.filterResults(results, icase)
      logger.debug(`Filtered items:${JSON.stringify(items)}`)
      if (!items || items.length === 0) {
        await increment.stop(nvim)
        return
      }
      if (items.length == 1) {
        await increment.stop(nvim)
      }
      nvim.setVar('coc#_context', {
        start: startcol,
        candidates: items
      })
      nvim.call('coc#_do_complete', []).then(() => {
        logger.debug(`Complete time cost: ${Date.now() - start}ms`)
      })
    }
  }

  // callback for remote sources
  @Function('CocResult', {sync: false})
  public async cocResult(args: any[]):Promise<void> {
    let id = Number(args[0])
    let name = args[1] as string
    let items = args[2] as VimCompleteItem[]
    items = items || []
    logger.debug(`Remote ${name} result count: ${items.length}`)
    remoteStore.setResult(id, name, items)
  }

  // Used for :checkhealth
  @Function('CocCheck', {sync: true})
  public async cocCheck():Promise<string[] | null> {
    let {nvim} = this
    await remotes.init(nvim, natives.names, true)
    let {names} = remotes
    let success = true
    for (let name of names) {
      let source = remotes.createSource(nvim, name, true)
      if (source == null) {
        success = false
      }
    }
    return success ? names: null
  }

  @Function('CocSourceStat', {sync: true})
  public async cocSourceStat():Promise<SourceStat[]> {
    let disabled = getConfig('disabled')
    let res: SourceStat[] = []
    let items:any = natives.list.concat(remotes.list as any)
    for (let item of items) {
      let {name, filepath} = item
      res.push({
        name,
        type: natives.has(name) ? 'native' : 'remote',
        disabled: disabled.indexOf(name) !== -1,
        filepath
      })
    }
    return res
  }

  // TODO remove this
  @Function('CocSourceConfig', {sync: false})
  public async cocSourceConfig(args: any):Promise<void> {
    let name:string = args[0]
    let config:{[index:string]: any} = args[1]
    if (!name) return
    configSource(name, config)
  }

  @Function('CocSourceToggle', {sync: true})
  public async cocSourceToggle(args: any):Promise<string> {
    let name = args[0].toString()
    if (!name) return ''
    if (!natives.has(name) && !remotes.has(name)) {
      await echoErr(this.nvim, `Source ${name} not found`)
      return ''
    }
    return toggleSource(name)
  }

  @Function('CocSourceRefresh', {sync: true})
  public async cocSourceRefresh(args: any):Promise<boolean> {
    let name = args[0].toString()
    if (name) {
      let m = natives.has(name) ? natives : remotes
      let source = await m.getSource(this.nvim, name)
      if (!source) {
        await echoErr(this.nvim, `Source ${name} not found`)
        return false
      }
      await source.refresh()
    } else {
      for (let m of [remotes, natives]) {
        for (let s of m.sources) {
          if (s) {
            await s.refresh()
          }
        }
      }
    }
    return true
  }

  private async onBufferChange(bufnr: string):Promise<void> {
    let listed = await this.nvim.call('getbufvar', [Number(bufnr), '&buflisted'])
    if (listed) await buffers.addBuffer(this.nvim, bufnr)
  }

  private async initConfig(): Promise<void> {
    let {nvim} = this
    let opts: {[index: string]: any} = await nvim.call('coc#get_config', [])
    setConfig(opts)
  }
}
