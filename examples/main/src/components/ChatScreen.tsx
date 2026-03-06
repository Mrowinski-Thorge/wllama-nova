/* eslint-disable */
// @ts-nocheck
import { useState } from 'react';
import { useMessages } from '../utils/messages.context';
import { useWllama } from '../utils/wllama.context';
import { Message, Screen } from '../utils/types';
import { formatChat } from '../utils/utils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStop, faBook, faBolt, faSpinner, faChevronDown, faChevronRight, faLink, faDatabase } from '@fortawesome/free-solid-svg-icons';
import ScreenWrapper from './ScreenWrapper';
import { useIntervalWhen } from '../utils/use-interval-when';
import { MarkdownMessage } from './MarkdownMessage';

export default function ChatScreen() {
  const [input, setInput] = useState('');
  const [useWiki, setUseWiki] = useState(false);
  
  // Agent States
  const [agentStatus, setAgentStatus] = useState('');
  const [agentDetails, setAgentDetails] = useState([]); 
  const [showAgentDetails, setShowAgentDetails] = useState(false);
  const [agentFinished, setAgentFinished] = useState(false); 

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

  // Hilfsfunktion fürs UI-Log
  const addLog = (msg) => setAgentDetails(prev => [...prev, msg]);

  const onSubmit = async () => {
    if (isGenerating || agentStatus || input.trim() === '') return;

    const userInput = input.trim();
    setInput('');
    setAgentDetails([]); 
    setAgentFinished(false);
    setShowAgentDetails(false); // STANDARDMÄSSIG ZUGEKLAPPT!
    
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

    // 1. STANDARD NOVA PROMPT (Ohne Wikipedia)
    let internalPrompt = `[System-Anweisung: Du bist Nova, ein hochintelligenter und präziser KI-Assistent. Beantworte die Frage des Nutzers auf den Punkt, ohne unnötige Umschweife. Berücksichtige dabei zwingend den bisherigen Chatverlauf.]\n\nNutzerfrage: ${userInput}`;
    let sourceUrls = [];

    // --- 2. WIKIPEDIA AGENT (MULTI-SEARCH) ---
    if (useWiki) {
      setAgentStatus('Arbeitet mit Wikipedia daran...');
      addLog('Analysiere Frage für beste Suchbegriffe...');

      // STRIKTER PROMPT FÜR SUCHBEGRIFFE (Keine Sätze erlaubt!)
      const queryPrompt = `<|im_start|>system\nExtrahiere 1 bis maximal 5 Wikipedia-Schlagwörter aus der folgenden Eingabe. \nREGELN:\n- NUR Schlagwörter oder Namen (z.B. "Albert Einstein", "Quantenphysik").\n- KEINE ganzen Sätze.\n- KEINE Erklärungen.\n- Trenne die Begriffe NUR mit Kommas.\n<|im_end|>\n<|im_start|>user\n${userInput}<|im_end|>\n<|im_start|>assistant\n`;

      let queryResponse = "";
      try {
        await createCompletion(queryPrompt, piece => { queryResponse = piece; });
      } catch (e) { console.error(e); }

      let terms = queryResponse.split(',').map(t => t.replace(/["']/g, '').trim()).filter(t => t);
      if (terms.length === 0) terms = [userInput];
      terms = terms.slice(0, 5); 

      addLog(`Suche nach Begriffen: ${terms.join(', ')}`);

      let wikiContext = "";
      let foundCount = 0;

      for (let term of terms) {
        try {
          const searchRes = await fetch(`https://de.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&utf8=&format=json&origin=*`);
          const searchData = await searchRes.json();

          if (searchData.query?.search?.length > 0) {
            const exactTitle = searchData.query.search[0].title;
            const summaryRes = await fetch(`https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(exactTitle)}`);
            const summaryData = await summaryRes.json();

            if (summaryData.extract && !sourceUrls.includes(summaryData.content_urls?.desktop?.page)) {
              sourceUrls.push(summaryData.content_urls?.desktop?.page || `https://de.wikipedia.org/wiki/${encodeURIComponent(exactTitle)}`);
              wikiContext += `\n--- Info zu "${exactTitle}": ---\n${summaryData.extract}\n`;
              foundCount++;
              addLog(`Gefunden: "${exactTitle}"`);
            }
          }
        } catch (e) { 
           /* Fehler ignorieren */
        }
      }
      
      if (foundCount > 0) {
         setAgentStatus(`${foundCount} Wikipedia Einträge analysiert.`);
         // NOVA PROMPT WENN WIKIPEDIA AKTIV IST
         internalPrompt = `[System-Anweisung: Du bist Nova, ein präziser KI-Assistent. Dir wurden aktuelle Fakten aus Wikipedia bereitgestellt. Nutze AUSSCHLIESSLICH diese Fakten, um die Frage zu beantworten. Fasse dich klar und präzise.]\n\nWIKIPEDIA-FAKTEN:\n${wikiContext}\n\nNutzerfrage: ${userInput}`;
      } else {
         setAgentStatus('Keine passenden Wikipedia-Einträge gefunden.');
      }
      setAgentFinished(true); 
    }

    // --- 3. NORMALE ANTWORT GENERIEREN ---
    const hiddenUserMsg: Message = { ...userMsg, content: internalPrompt };
    let formattedChat = await formatChat(getWllamaInstance(), [...historyForLLM, hiddenUserMsg]);

    let finalAnswer = "";
    await createCompletion(formattedChat, (newContent) => {
      finalAnswer = newContent;
      let display = sourceUrls.length > 0 ? finalAnswer + `\n\n===SOURCES===${sourceUrls.join('|||')}` : finalAnswer;
      editMessageInConversation(convId, assistantMsg.id, display);
    });

    // --- 4. POST-KOMPRESSION ---
    if (currentTokens > COMPRESS_LIMIT) {
      setAgentStatus('Komprimiere Chat-Speicher...');
      setAgentFinished(false);
      setShowAgentDetails(true);
      setAgentDetails(['Fasse Verlauf im Hintergrund zusammen, um Token zu sparen...']);

      const historyToCompress = [...historyForLLM, hiddenUserMsg, { role: 'assistant', content: finalAnswer }];
      const compressPrompt = `<|im_start|>system\nFasse den folgenden Chatverlauf in maximal 3 Sätzen zusammen. Behalte alle wichtigen Fakten.<|im_end|>\n<|im_start|>user\n${JSON.stringify(historyToCompress)}<|im_end|>\n<|im_start|>assistant\n`;
      
      let summary = "";
      await createCompletion(compressPrompt, piece => { summary = piece; });

      let updatedDisplay = sourceUrls.length > 0 ? finalAnswer + `\n\n===SOURCES===${sourceUrls.join('|||')}` : finalAnswer;
      updatedDisplay += `\n\n===MEMORY===[KOMPRIMIERTER KONTEXT]: ${summary}`;
      
      editMessageInConversation(convId, assistantMsg.id, updatedDisplay);
    }
    
    setAgentStatus('');
    setAgentFinished(false);
  };

  return (
    <ScreenWrapper fitScreen>
      {/* CSS FÜR DEN SHIMMER EFFEKT */}
      <style>{`
        @keyframes shimmer-sweep {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        .shimmer-text {
          background: linear-gradient(90deg, #3abff8 20%, #ffffff 50%, #3abff8 80%);
          background-size: 200% auto;
          color: transparent;
          -webkit-background-clip: text;
          background-clip: text;
          animation: shimmer-sweep 2.5s linear infinite;
        }
      `}</style>

      <div className="chat-messages grow overflow-auto" id="chat-history">
        <div className="h-10" />

        <div className="text-center mb-4 opacity-50 text-xs font-mono">
          <FontAwesomeIcon icon={faDatabase} className="mr-1" />
          Aktueller Kontext: ~{currentTokens} / {COMPRESS_LIMIT} Token
        </div>

        {currConv ? (
          <>
            {currConv.messages.map((msg) => {
              if (msg.role === 'user') {
                return (
                  <div className="chat chat-end" key={msg.id}>
                    <div className="chat-bubble">
                      <MarkdownMessage content={msg.content} />
                    </div>
                  </div>
                );
              }

              let text = msg.content;
              let sources = [];
              let memory = null;

              if (text.includes('===MEMORY===')) {
                const parts = text.split('===MEMORY===');
                text = parts[0];
                memory = parts[1].replace('[KOMPRIMIERTER KONTEXT]:', '').trim();
              }
              if (text.includes('===SOURCES===')) {
                const parts = text.split('===SOURCES===');
                text = parts[0];
                sources = parts[1].trim().split('|||').filter(s => s);
              }

              return (
                <div key={msg.id} className="flex flex-col items-start w-full mb-6 px-4">
                  {/* --- AGENT DENK-BLASE (ohne blauen Rahmen, mit Shimmer) --- */}
                  {(msg.content === '' || agentStatus) && msg.id === Math.max(...currConv.messages.map(m=>m.id)) && useWiki && (
                    <div className="mb-2 bg-base-300 rounded-lg p-2 max-w-[80%]">
                      <div 
                        className="flex items-center cursor-pointer text-sm font-semibold opacity-80 hover:opacity-100 transition-opacity"
                        onClick={() => setShowAgentDetails(!showAgentDetails)}
                      >
                        <div className="relative w-6 h-6 mr-2 flex items-center justify-center">
                           <FontAwesomeIcon icon={faBook} className="text-info text-xs absolute z-10" />
                           {!agentFinished && <FontAwesomeIcon icon={faSpinner} spin className="text-info text-lg absolute opacity-50" />}
                        </div>
                        {/* Shimmer-Effekt wird hier angewendet, solange Agent sucht */}
                        <span className={agentFinished ? 'text-success' : 'shimmer-text'}>
                          {agentStatus || 'Warte auf Agent...'}
                        </span>
                        <FontAwesomeIcon icon={showAgentDetails ? faChevronDown : faChevronRight} className="ml-3 text-xs opacity-50" />
                      </div>
                      
                      {/* LOGS: Normale Schriftart (font-sans statt font-mono), kein blauer Rand links */}
                      {showAgentDetails && agentDetails.length > 0 && (
                        <div className="mt-3 pl-2 space-y-1 py-1">
                          {agentDetails.map((log, idx) => (
                            <div key={idx} className="text-xs font-sans opacity-70">
                              {log}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* --- DIE NORMALE ANTWORT SPRECHBLASE --- */}
                  <div className="chat chat-start w-full">
                    <div className="chat-bubble bg-base-100 text-base-content max-w-full">
                      {msg.content.length === 0 && isGenerating && (!useWiki || agentFinished) ? (
                        <span className="loading loading-dots"></span>
                      ) : (
                        msg.content.length > 0 && (
                          <>
                            <MarkdownMessage content={text} />
                            
                            {sources.length > 0 && (
                              <div className="mt-4 pt-3 border-t border-base-300 flex flex-wrap gap-2">
                                {sources.map((src, i) => (
                                  <a key={i} href={src} target="_blank" rel="noreferrer" className="btn btn-xs btn-outline btn-info opacity-70 hover:opacity-100">
                                    <FontAwesomeIcon icon={faLink} className="mr-1" /> Wiki [{i+1}]
                                  </a>
                                ))}
                              </div>
                            )}

                            {memory && (
                              <div className="mt-2 text-[10px] opacity-40 italic border-l-2 border-warning pl-2">
                                <FontAwesomeIcon icon={faBolt} className="mr-1" />
                                Speicher nach dieser Nachricht komprimiert.
                              </div>
                            )}
                          </>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <div className="pt-24 text-center text-xl">Frag mich etwas 👋</div>
        )}
      </div>

      <div className="flex flex-col input-message py-4 relative">
        {isGenerating && (!useWiki || agentFinished) && (
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
            <button 
              className={`absolute bottom-4 left-5 btn btn-xs ${useWiki ? 'btn-info shadow-lg shadow-info/50' : 'btn-ghost'}`}
              onClick={() => setUseWiki(!useWiki)}
            >
              <FontAwesomeIcon icon={faBook} /> Wiki: {useWiki ? 'AN' : 'AUS'}
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
