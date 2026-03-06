import { useState } from 'react';
import { useMessages } from '../utils/messages.context';
import { useWllama } from '../utils/wllama.context';
import { Message, Screen } from '../utils/types';
import { formatChat } from '../utils/utils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStop, faBook, faBolt } from '@fortawesome/free-solid-svg-icons';
import ScreenWrapper from './ScreenWrapper';
import { useIntervalWhen } from '../utils/use-interval-when';
import { MarkdownMessage } from './MarkdownMessage';

export default function ChatScreen() {
  const [input, setInput] = useState('');
  const [useWiki, setUseWiki] = useState(false);
  const [agentStatus, setAgentStatus] = useState('');

  const {
    currentConvId,
    isGenerating,
    createCompletion,
    navigateTo,
    loadedModel,
    getWllamaInstance,
    stopCompletion,
    currParams,
  } = useWllama();
  
  const {
    getConversationById,
    addMessageToConversation,
    editMessageInConversation,
    newConversation,
  } = useMessages();

  useIntervalWhen(chatScrollToBottom, 500, isGenerating, true);

  const currConv = getConversationById(currentConvId);

  // Token-Limit und Memory-Warnung
  const estTokens = currConv ? Math.ceil(JSON.stringify(currConv.messages).length / 4) : 0;
  const maxTokens = currParams?.nContext || 2048;
  const isWarningLimit = estTokens > maxTokens * 0.75;
  const isCriticalLimit = estTokens > maxTokens * 0.90;

  const onSubmit = async () => {
    if (isGenerating || input.trim() === '') return;

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

    // Memory Kompression
    if (isCriticalLimit) {
      internalPrompt = `[WICHTIG: Kontextspeicher ist fast voll! Fasse in deiner Antwort zuerst die bisherige Unterhaltung sehr kurz zusammen und beantworte dann:]\n\n${internalPrompt}`;
    }

    // Wikipedia Suche
    if (useWiki) {
      setAgentStatus('Suche auf Wikipedia...');
      try {
        const res = await fetch(`https://de.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(userInput)}&utf8=&format=json&origin=*`);
        const data = await res.json();
        
        if (data.query?.search?.length > 0) {
          const result = data.query.search[0];
          const snippet = result.snippet.replace(/(<([^>]+)>)/gi, "");
          const wikiLink = `https://de.wikipedia.org/?curid=${result.pageid}`;
          
          internalPrompt = `Fakt von Wikipedia: "${snippet}".\n\nBeantworte meine Frage basierend darauf. Füge am ENDE deiner Antwort diesen Quellen-Link ein: [Quelle: Wikipedia](${wikiLink})\n\nFrage: ${internalPrompt}`;
        }
      } catch (e) {
        console.error("Wiki Error:", e);
      }
      setAgentStatus('');
    }

    const hiddenUserMsg: Message = { ...userMsg, content: internalPrompt };

    let formattedChat: string;
    try {
      formattedChat = await formatChat(getWllamaInstance(), [...currHistory, hiddenUserMsg]);
    } catch (e) {
      alert(`Error: ${(e as any)?.message ?? 'unknown'}`);
      throw e;
    }

    await createCompletion(formattedChat, (newContent) => {
      editMessageInConversation(convId, assistantMsg.id, newContent);
    });
  };

  return (
    <ScreenWrapper fitScreen>
      <div className="chat-messages grow overflow-auto" id="chat-history">
        <div className="h-10" />

        {isWarningLimit && (
          <div className="text-center mb-4">
            <span className={`badge ${isCriticalLimit ? 'badge-error animate-pulse' : 'badge-warning'} p-3`}>
              <FontAwesomeIcon icon={faBolt} className="mr-2" />
              {isCriticalLimit ? "Speicher fast voll! Chat wird komprimiert." : "Speicher füllt sich."} 
              ({estTokens} / {maxTokens} Tokens)
            </span>
          </div>
        )}

        {currConv ? (
          <>
            {currConv.messages.map((msg) =>
              msg.role === 'user' ? (
                <div className="chat chat-end" key={msg.id}>
                  <div className="chat-bubble">
                    {msg.content.length > 0 && <MarkdownMessage content={msg.content} />}
                  </div>
                </div>
              ) : (
                <div className="chat chat-start" key={msg.id}>
                  <div className="chat-bubble bg-base-100 text-base-content">
                    {msg.content.length === 0 && isGenerating && <span className="loading loading-dots"></span>}
                    {msg.content.length > 0 && <MarkdownMessage content={msg.content} />}
                  </div>
                </div>
              )
            )}
          </>
        ) : (
          <div className="pt-24 text-center text-xl">Frag mich etwas 👋</div>
        )}
      </div>

      <div className="flex flex-col input-message py-4 relative">
        {isGenerating && (
          <div className="text-center">
            <button className="btn btn-outline btn-sm mb-4" onClick={stopCompletion}>
              <FontAwesomeIcon icon={faStop} /> Stop generation
            </button>
          </div>
        )}

        {agentStatus && (
          <div className="text-sm text-info animate-pulse mb-2 text-center font-bold">
            <FontAwesomeIcon icon={faBook} className="mr-2" /> {agentStatus}
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
              <FontAwesomeIcon icon={faBook} className="mr-1" /> Wiki: {useWiki ? 'AN' : 'AUS'}
            </button>
            <span className="absolute bottom-3 right-3 text-xs opacity-50 font-mono">
              Tokens: ~{estTokens}
            </span>
          </div>
        )}

        {!loadedModel && <WarnNoModel />}
      </div>
    </ScreenWrapper>
  );
}

function WarnNoModel() {
  const { navigateTo } = useWllama();
  return (
    <div role="alert" className="alert">
      <span>Modell ist nicht geladen</span>
      <div>
        <button className="btn btn-sm btn-primary" onClick={() => navigateTo(Screen.MODEL)}>
          Modell wählen
        </button>
      </div>
    </div>
  );
}

const chatScrollToBottom = () => {
  const elem = document.getElementById('chat-history');
  elem?.scrollTo({ top: elem.scrollHeight, behavior: 'smooth' });
};
