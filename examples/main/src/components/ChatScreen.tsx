/* eslint-disable */
// @ts-nocheck
import { useState } from 'react';
import { useMessages } from '../utils/messages.context';
import { useWllama } from '../utils/wllama.context';
import { Message, Screen } from '../utils/types';
import { formatChat } from '../utils/utils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStop, faBook, faBolt, faSpinner, faChevronDown, faChevronUp, faLink } from '@fortawesome/free-solid-svg-icons';
import ScreenWrapper from './ScreenWrapper';
import { useIntervalWhen } from '../utils/use-interval-when';
import { MarkdownMessage } from './MarkdownMessage';

export default function ChatScreen() {
  const [input, setInput] = useState('');
  const [useWiki, setUseWiki] = useState(false);
  
  // Agent Status States
  const [agentStatus, setAgentStatus] = useState('');
  const [agentDetails, setAgentDetails] = useState('');
  const [showAgentDetails, setShowAgentDetails] = useState(false);

  const {
    currentConvId,
    isGenerating,
    createCompletion,
    navigateTo,
    loadedModel,
    getWllamaInstance,
    stopCompletion,
  } = useWllama();
  
  const {
    getConversationById,
    addMessageToConversation,
    editMessageInConversation,
    newConversation,
  } = useMessages();

  useIntervalWhen(chatScrollToBottom, 500, isGenerating, true);

  const currConv = getConversationById(currentConvId);

  // Neues Memory-Limit: 800 Tokens
  const estTokens = currConv ? Math.ceil(JSON.stringify(currConv.messages).length / 4) : 0;
  const COMPRESS_LIMIT = 800; 
  const isCriticalLimit = estTokens > COMPRESS_LIMIT;

  const onSubmit = async () => {
    if (isGenerating || agentStatus || input.trim() === '') return;

    const currHistory = currConv?.messages ?? [];
    const userInput = input.trim();
    setInput('');
    
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

    let internalPrompt = userInput;
    let sourceUrl = null;

    // --- WIKIPEDIA AGENTEN LOGIK ---
    if (useWiki) {
      setAgentStatus('Arbeitet mit Wikipedia daran...');
      setAgentDetails('Überlege besten Suchbegriff...');
      setShowAgentDetails(true);

      // 1. KI fragt sich selbst nach dem Suchbegriff
      const queryPrompt = `<|im_start|>system\nDu bist ein Assistent, der nur Suchbegriffe ausgibt. Extrahiere aus der folgenden Frage genau EINEN präzisen Wikipedia-Suchbegriff oder Namen. Antworte mit nichts anderem als dem Suchbegriff.<|im_end|>\n<|im_start|>user\n${userInput}<|im_end|>\n<|im_start|>assistant\n`;

      let searchQuery = "";
      try {
        await createCompletion(queryPrompt, (piece) => { searchQuery = piece; });
      } catch (e) { console.error(e); }

      // Säubern des generierten Begriffs
      searchQuery = searchQuery.replace(/["']/g, '').trim();
      setAgentDetails(`Frage Wikipedia API nach: "${searchQuery}"`);

      // 2. Echte Wikipedia Summary API abfragen
      try {
        const res = await fetch(`https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(searchQuery)}`);
        const data = await res.json();

        if (data.title && data.extract) {
          sourceUrl = data.content_urls?.desktop?.page || `https://de.wikipedia.org/wiki/${encodeURIComponent(data.title)}`;
          internalPrompt = `Fakten von Wikipedia zu "${data.title}":\n"${data.extract}"\n\nBeantworte basierend auf diesen Fakten die Frage: ${userInput}`;
          setAgentDetails(`Artikel "${data.title}" gefunden. Lese Zusammenfassung...`);
        } else {
          setAgentDetails(`Kein passender Artikel für "${searchQuery}" gefunden.`);
        }
      } catch(e) {
        setAgentDetails(`Wikipedia API Fehler.`);
      }
    }

    // --- MEMORY KOMPRESSION ---
    if (isCriticalLimit) {
      internalPrompt = `[WICHTIGE SYSTEMANWEISUNG: Der Speicher ist über 800 Tokens. Fasse unsere bisherige Unterhaltung extrem kurz zusammen und beantworte dann die Frage:]\n${internalPrompt}`;
    }

    // Agenten-UI verstecken, echte Generierung beginnt
    setAgentStatus('');
    setAgentDetails('');
    setShowAgentDetails(false);

    const hiddenUserMsg: Message = { ...userMsg, content: internalPrompt };
    let formattedChat = await formatChat(getWllamaInstance(), [...currHistory, hiddenUserMsg]);

    let finalAnswer = "";
    await createCompletion(formattedChat, (newContent) => {
      finalAnswer = newContent;
      // Quelle mit unsichtbarem Trennzeichen anfügen
      const displayContent = sourceUrl ? finalAnswer + `\n\n===SOURCES===${sourceUrl}` : finalAnswer;
      editMessageInConversation(convId, assistantMsg.id, displayContent);
    });
  };

  return (
    <ScreenWrapper fitScreen>
      <div className="chat-messages grow overflow-auto" id="chat-history">
        <div className="h-10" />

        {isCriticalLimit && (
          <div className="text-center mb-4">
            <span className="badge badge-warning p-3">
              <FontAwesomeIcon icon={faBolt} className="mr-2" />
              Token-Limit (800) erreicht. Auto-Kompression aktiv.
            </span>
          </div>
        )}

        {currConv ? (
          <>
            {currConv.messages.map((msg) => {
              // Text und Quellen trennen
              let text = msg.content;
              let source = null;
              if (text.includes('===SOURCES===')) {
                const parts = text.split('===SOURCES===');
                text = parts[0];
                source = parts[1].trim();
              }

              return (
                <div className={`chat ${msg.role === 'user' ? 'chat-end' : 'chat-start'}`} key={msg.id}>
                  <div className={`chat-bubble ${msg.role === 'assistant' ? 'bg-base-100 text-base-content' : ''}`}>
                    {msg.content.length === 0 && isGenerating && !agentStatus ? (
                      <span className="loading loading-dots"></span>
                    ) : (
                      <>
                        <MarkdownMessage content={text} />
                        {source && (
                          <div className="mt-3 border-t border-gray-600 pt-3">
                            <a href={source} target="_blank" rel="noreferrer" className="btn btn-xs btn-outline btn-info">
                              <FontAwesomeIcon icon={faLink} className="mr-2" /> Quelle: Wikipedia
                            </a>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <div className="pt-24 text-center text-xl">Frag mich etwas 👋</div>
        )}

        {/* --- DIE NEUE AGENTEN-SPRECHBLASE --- */}
        {agentStatus && (
          <div className="chat chat-start mt-2">
            <div className="chat-bubble bg-base-300 text-base-content border border-info shadow-lg">
              <div 
                className="flex items-center cursor-pointer font-semibold text-sm" 
                onClick={() => setShowAgentDetails(!showAgentDetails)}
              >
                <FontAwesomeIcon icon={faSpinner} spin className="mr-3 text-info text-lg" />
                {agentStatus}
                <FontAwesomeIcon icon={showAgentDetails ? faChevronUp : faChevronDown} className="ml-3 text-xs opacity-50" />
              </div>
              {showAgentDetails && (
                <div className="mt-3 text-xs opacity-80 border-l-2 border-info pl-3 py-1 bg-base-200 rounded-r">
                  {agentDetails}
                </div>
              )}
            </div>
          </div>
        )}
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
          <div className="relative w-full">
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
              className={`absolute bottom-3 left-3 btn btn-xs ${useWiki ? 'btn-info' : 'btn-ghost'}`}
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
