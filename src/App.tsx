import { ToolForm } from "./components/Toolform";
import ffmpegSchemaJson from "./schemas/ffmpeg-schema.json";
import type { ToolSchema } from "./engine/buildArgsArray";

const ffmpegSchema = ffmpegSchemaJson as unknown as ToolSchema;

function App() {
    return <ToolForm schema={ffmpegSchema} />;
}

export default App;