/* eslint-disable */
// @ts-nocheck
import { useState } from 'react';
import { useMessages } from '../utils/messages.context';
import { useWllama } from '../utils/wllama.context';
import { Message, Screen } from '../utils/types';
import { formatChat } from '../utils/utils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStop, faBook, faBolt, faSpinner, faCheckCircle, faDatabase, faWifi } from '@fortawesome/free-solid-svg-icons';
import ScreenWrapper from './ScreenWrapper';
import { useIntervalWhen } from '../utils/use-interval-when';
import { MarkdownMessage } from './MarkdownMessage';

export default function ChatScreen() {
  const [input, setInput] = useState('');
  const [useWiki, setUseWiki] = useState(false);
  
  // Agent States für die LIVE-Generierung
  const [agentStatus, setAgentStatus] = useState('');
  const [agentDetails, setAgentDetails] = useState([]); 

  const { currentConvId, isGenerating, createCompletion, navigateTo, loadedModel, getWllamaInstance, stopCompletion } = useWllama();
  const { getConversationById, addMessageToConversation, editMessageInConversation, newConversation } = useMessages();

  useIntervalWhen(chatScrollToBottom, 500, isGenerating || !!agentStatus, true);

  const currConv = getConversationById(currentConvId);

  // Memory Logik
  const currHistory = currConv?.messages ?? [];
  const lastMemoryIdx = currHistory.findLastIndex(m => m.content.includes('===MEMORY==='));
  const historyForLLM = lastMemoryIdx !== -1 ? currHistory.slice(lastMemoryIdx) : currHistory;
  const currentTokens = Math.ceil(JSON.stringify(historyForLLM).length / 4);
  const COMPRESS_LIMIT = 800;

  // Verbindungs-Check für Wikipedia
  const toggleWiki = async () => {
    if (useWiki) {
      setUseWiki(false);
      return;
    }
    try {
      // Teste kurz die Wikipedia API
      const res = await fetch("https://de.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=general&format=json&origin=*", { cache: "no-store" });
      if (res.ok) {
        setUseWiki(true);
      } else {
        throw new Error("No Connection");
      }
    } catch (e) {
      alert("Fehlermeldung: Keine Verbindung zur Wikipedia API. Offline-Modus ist aktiv. Die Modelle laden direkt aus dem lokalen Cache.");
      setUseWiki(false);
    }
  };

  const onSubmit = async () => {
    if (isGenerating || agentStatus || input.trim() === '') return;

    const userInput = input.trim();
    setInput('');
    setAgentDetails([]); 
    
    const userMsg: Message = { id: Date.now(), content: userInput, role: 'user' };
    const assistantMsg: Message = { id: Date.now() + 1, content: '', role: 'assistant' };

    let convId = currConv?.id;
    if (!convId) {
      const newConv = newConversation(userMsg);
      convId = newConv.id;
      navigateTo(Screen.CHAT, convId);
      addMessageToConversation(convId, assistantMsg);
    } else {
      addMessageToConversation(convId, userMsg);
      addMessageToConversation(convId, assistantMsg);
    }

    if (!loadedModel) throw new Error('loadedModel is null');

    let wikiContext = "";
    let sourceUrls = [];
    let currentAgentLogs = [];

    const addLog = (msg) => {
      setAgentDetails(prev => [...prev, msg]);
      currentAgentLogs.push(msg); // Speichert Logs für die Historie
    };

    // --- 1. WIKIPEDIA AGENT (1-3 STICHWÖRTER) ---
    if (useWiki) {
      setAgentStatus('Arbeitet mit Wikipedia daran...');
      addLog('Analysiere Frage für Suchbegriffe...');

      const queryPrompt = `<|im_start|>system\nGib 1 bis maximal 3 Wikipedia-Suchbegriffe aus. REGELN: Nur Wörter, KEINE Sätze, Trennung durch Komma. Beispiel: "Mars, Raumfahrt, Astronomie"<|im_end|>\n<|im_start|>user\n${userInput}<|im_end|>\n<|im_start|>assistant\n`;

      let queryResponse = "";
      try {
        await createCompletion(queryPrompt, piece => { queryResponse = piece; });
      } catch (e) {}

      let cleaned = queryResponse.split(/antwort:|begriffe:|:/i).pop();
      let terms = cleaned.split(',').map(t => t.replace(/[.!?"'•-]/g, '').trim()).filter(t => t.length > 2);
      if (terms.length === 0) terms = [userInput];
      terms = terms.slice(0, 3); // Maximal 3 Begriffe erzwingen!

      addLog(`Suche nach: ${terms.join(', ')}`);

      for (let term of terms) {
        try {
          const searchRes = await fetch(`https://de.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&utf8=&format=json&origin=*`);
          const searchData = await searchRes.json();
          if (searchData.query?.search?.length > 0) {
            const exactTitle = searchData.query.search[0].title;
            const summaryRes = await fetch(`https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(exactTitle)}`);
            const summaryData = await summaryRes.json();
            if (summaryData.extract && !sourceUrls.includes(summaryData.content_urls?.desktop?.page)) {
              sourceUrls.push(summaryData.content_urls?.desktop?.page);
              wikiContext += `\nFAKT (${exactTitle}): ${summaryData.extract}\n`;
              addLog(`Gefunden: ${exactTitle}`);
            }
          }
        } catch (e) {}
      }
      setAgentStatus(''); // Live-Status beenden
    }

    // --- 2. NOVA SYSTEM PROMPT ---
    const systemPrompt = `Du bist Nova, ein präziser KI-Assistent. 
1. PRIORITÄT: Nutze bereitgestellte Fakten (Wikipedia) vor deinem Wissen.
2. STRUKTUR: Antworte in kurzen, logischen Absätzen.
3. DIREKTHEIT: Keine einleitenden Floskeln. Komm sofort zum Punkt.`;

    const internalPrompt = `<|im_start|>system\n${systemPrompt}\n${wikiContext ? "\nKONTEXT:\n" + wikiContext : ""}<|im_end|>\n<|im_start|>user\n${userInput}<|im_end|>\n<|im_start|>assistant\n`;

    // --- 3. GENERIERUNG ---
    const hiddenUserMsg = { ...userMsg, content: internalPrompt };
    let formattedChat = await formatChat(getWllamaInstance(), [...historyForLLM, hiddenUserMsg]);

    let finalAnswer = "";
    
    // Baut den String mit allen versteckten Daten für die Historie zusammen
    const buildDisplayString = (text) => {
      let res = text;
      if (currentAgentLogs.length > 0) res += `\n\n===AGENT===${currentAgentLogs.join('|||')}`;
      if (sourceUrls.length > 0) res += `\n\n===SOURCES===${sourceUrls.join('|||')}`;
      return res;
    };

    await createCompletion(formattedChat, (newContent) => {
      finalAnswer = newContent;
      editMessageInConversation(convId, assistantMsg.id, buildDisplayString(finalAnswer));
    });

    // --- 4. POST-KOMPRESSION ---
    if (currentTokens > COMPRESS_LIMIT) {
      setAgentStatus('Speicher-Optimierung...');
      const historyToCompress = [...historyForLLM, hiddenUserMsg, { role: 'assistant', content: finalAnswer }];
      const compressPrompt = `<|im_start|>system\nFasse diesen Verlauf extrem kurz in 3 Sätzen zusammen.<|im_end|>\n<|im_start|>user\n${JSON.stringify(historyToCompress)}<|im_end|>\n<|im_start|>assistant\n`;
      
      let summary = "";
      await createCompletion(compressPrompt, piece => { summary = piece; });
      
      editMessageInConversation(convId, assistantMsg.id, buildDisplayString(finalAnswer) + `\n\n===MEMORY===${summary}`);
    }
    setAgentStatus('');
  };

  return (
    <ScreenWrapper fitScreen>
      <style>{`
        @keyframes shimmer-fast {
          0% { background-position: -150% center; }
          100% { background-position: 150% center; }
        }
        .shimmer-text {
          background: linear-gradient(90deg, #3abff8 20%, #ffffff 50%, #3abff8 80%);
          background-size: 200% auto;
          color: transparent;
          -webkit-background-clip: text;
          animation: shimmer-fast 2s linear infinite;
        }
        details > summary { list-style: none; }
        details > summary::-webkit-details-marker { display: none; }
      `}</style>

      <div className="chat-messages grow overflow-auto px-4" id="chat-history">
        <div className="h-10" />
        {currConv?.messages.map((msg) => {
          let text = msg.content;
          let sources = [];
          let agentLogs = [];
          let memory = text.includes('===MEMORY===');
          
          if (memory) text = text.split('===MEMORY===')[0];
          if (text.includes('===SOURCES===')) {
            const parts = text.split('===SOURCES===');
            text = parts[0];
            sources = parts[1].split('===')[0].split('|||').filter(s => s);
          }
          if (text.includes('===AGENT===')) {
            const parts = text.split('===AGENT===');
            text = parts[0];
            agentLogs = parts[1].split('===')[0].split('|||').filter(s => s);
          }

          return (
            <div key={msg.id} className="flex flex-col w-full mb-6">
              
              {/* --- AGENTEN VERLAUF (Historie oder Live) --- */}
              {((msg.content === '' && agentStatus) || agentLogs.length > 0) && msg.role === 'assistant' && (
                <details className="mb-2 bg-base-300 rounded-lg p-2 max-w-[85%] self-start group cursor-pointer" open={msg.content === '' && agentStatus}>
                  <summary className="flex items-center text-sm font-semibold outline-none">
                    <div className="relative w-6 h-6 mr-2 flex items-center justify-center">
                       {msg.content === '' && agentStatus ? (
                         <>
                           <FontAwesomeIcon icon={faBook} className="text-info text-xs absolute z-10" />
                           <FontAwesomeIcon icon={faSpinner} spin className="text-info text-lg absolute opacity-40" />
                         </>
                       ) : (
                         <FontAwesomeIcon icon={faCheckCircle} className="text-success text-base" />
                       )}
                    </div>
                    {msg.content === '' && agentStatus ? (
                      <span className="shimmer-text">{agentStatus}</span>
                    ) : (
                      <span className="text-success opacity-80 group-hover:opacity-100 transition-opacity">Mit Wikipedia bearbeitet</span>
                    )}
                  </summary>
                  
                  <div className="mt-2 pl-8 space-y-1 pb-1">
                    {(msg.content === '' ? agentDetails : agentLogs).map((log, idx) => (
                      <div key={idx} className="text-[11px] font-mono opacity-70 leading-tight border-l border-base-content/20 pl-2">{log}</div>
                    ))}
                  </div>
                </details>
              )}

              {/* --- CHAT NACHRICHT --- */}
              <div className={`chat ${msg.role === 'user' ? 'chat-end' : 'chat-start'}`}>
                <div className={`chat-bubble ${msg.role === 'assistant' ? 'bg-base-100 text-base-content' : ''}`}>
                  {msg.content === '' && isGenerating && !agentStatus ? (
                    <span className="loading loading-dots"></span>
                  ) : (
                    <>
                      <MarkdownMessage content={text} />
                      
                      {/* --- AUFKLAPPBARE QUELLEN --- */}
                      {sources.length > 0 && (
                        <details className="mt-4 pt-2 border-t border-base-300 group">
                          <summary className="text-xs font-bold opacity-60 cursor-pointer outline-none hover:opacity-100 transition-opacity">
                            <FontAwesomeIcon icon={faBook} className="mr-1" /> Quellen ansehen
                          </summary>
                          <div className="mt-2 flex flex-col gap-1 pl-2 border-l-2 border-info">
                            {sources.map((src, i) => (
                              <a key={i} href={src} target="_blank" rel="noreferrer" className="text-[11px] text-info hover:underline truncate">
                                {decodeURIComponent(src.split('/').pop().replace(/_/g, ' '))}
                              </a>
                            ))}
                          </div>
                        </details>
                      )}

                      {memory && (
                        <div className="mt-2 text-[10px] opacity-40 italic border-l-2 border-warning pl-2">
                          <FontAwesomeIcon icon={faBolt} className="mr-1" />
                          Speicher komprimiert.
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col input-message py-4 relative">
        {isGenerating && !agentStatus && (
          <div className="text-center">
            <button className="btn btn-outline btn-sm mb-4" onClick={stopCompletion}>
              <FontAwesomeIcon icon={faStop} /> Stop
            </button>
          </div>
        )}

        {loadedModel && (
          <div className="relative w-full px-2">
            <textarea
              className="textarea textarea-bordered w-full pb-10" 
              placeholder="Deine Nachricht..."
              disabled={isGenerating || !!agentStatus}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.keyCode === 13 && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit();
                }
              }}
            />
            {/* Wiki Toggle mit Offline-Check */}
            <button 
              className={`absolute bottom-4 left-5 btn btn-xs ${useWiki ? 'btn-info shadow-lg shadow-info/50' : 'btn-ghost'}`}
              onClick={toggleWiki}
            >
              {useWiki ? <FontAwesomeIcon icon={faWifi} className="mr-1"/> : <FontAwesomeIcon icon={faBook} className="mr-1" />}
              Wiki: {useWiki ? 'AN' : 'AUS'}
            </button>
          </div>
        )}
      </div>
    </ScreenWrapper>
  );
}

const chatScrollToBottom = () => {
  const elem = document.getElementById('chat-history');
  elem?.scrollTo({ top: elem.scrollHeight, behavior: 'smooth' });
};
