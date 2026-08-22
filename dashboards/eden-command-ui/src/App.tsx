import Atmosphere from "./components/Atmosphere";
import TopBar from "./components/TopBar";
import ReactorCore from "./components/ReactorCore";
import CoreMetricsPanel from "./components/CoreMetricsPanel";
import AgentsPanel from "./components/AgentsPanel";
import ChatPanel from "./components/ChatPanel";
import LiveFeedPanel from "./components/LiveFeedPanel";
import ClientPanel from "./components/ClientPanel";

export default function App() {
  return (
    <>
      <Atmosphere />
      <div className="shell">
        <TopBar />
        <div className="columns">
          <div className="column">
            <ReactorCore />
            <CoreMetricsPanel />
            <AgentsPanel />
          </div>
          <div className="column">
            <ChatPanel />
          </div>
          <div className="column">
            <LiveFeedPanel />
            <ClientPanel />
          </div>
        </div>
      </div>
    </>
  );
}
