import { useCallback, useState } from "react";
import Atmosphere from "./components/Atmosphere";
import TopBar from "./components/TopBar";
import ReactorCore from "./components/ReactorCore";
import AgentDossierPanel from "./components/AgentDossierPanel";
import CoreMetricsPanel from "./components/CoreMetricsPanel";
import AgentsPanel from "./components/AgentsPanel";
import ChatPanel from "./components/ChatPanel";
import LiveFeedPanel from "./components/LiveFeedPanel";
import ClientPanel from "./components/ClientPanel";
import ModuleScreen from "./components/ModuleScreen";

export default function App() {
  const [activeTab, setActiveTab] = useState("COMMAND");
  const [selectedAgent, setSelectedAgent] = useState("SCT");
  const [voiceLevel, setVoiceLevel] = useState(0);

  const handleVoiceLevelChange = useCallback((level: number) => setVoiceLevel(level), []);

  return (
    <div className="eden-root">
      <Atmosphere />
      <div className="eden-shell">
        <TopBar activeTab={activeTab} onTabChange={setActiveTab} />

        {activeTab === "COMMAND" ? (
          <div className="columns">
            <div className="col-left">
              <AgentDossierPanel selectedCode={selectedAgent} />
              <CoreMetricsPanel />
              <AgentsPanel selectedCode={selectedAgent} onSelectAgent={setSelectedAgent} />
            </div>
            <div className="col-center">
              <ReactorCore selectedAgent={selectedAgent} onSelectAgent={setSelectedAgent} voiceLevel={voiceLevel} />
              <ChatPanel onVoiceLevelChange={handleVoiceLevelChange} />
            </div>
            <div className="col-right">
              <LiveFeedPanel />
              <ClientPanel />
            </div>
          </div>
        ) : (
          <ModuleScreen tab={activeTab} />
        )}
      </div>
    </div>
  );
}
