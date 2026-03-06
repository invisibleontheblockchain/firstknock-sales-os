// ... keep existing code (all imports through line 108) ...

export default function Home() {
    const queryClient = useQueryClient();
    const [activeRoute, setActiveRoute] = useState(null);
    const [activeRouteSoldFilter, setActiveRouteSoldFilter] = useState('all');
    const [showChecklist, setShowChecklist] = useState(false);

    // ... keep existing code (filteredActiveRoute useMemo) ...

    const [showRoutePanel, setShowRoutePanel] = useState(false);
    const [showCompare, setShowCompare] = useState(false);
    const [housesPerRoute, setHousesPerRoute] = useState(999999); // Default: 1 big route with all properties
    const [maxRouteDistance, setMaxRouteDistance] = useState(10); // Default 10 miles
    const ROUTE_SIZE_OPTIONS = [25, 50, 75, 100];
    const [sortBy, setSortBy] = useState('score'); // score, houses, distance
    const [minScore, setMinScore] = useState(0);
    const [quickFilter, setQuickFilter] = useState('all'); // all, eligible, sold, rejected
    const [repFilter, setRepFilter] = useState('all');
    const [previewRoute, setPreviewRoute] = useState(null);
    const [startLocation, setStartLocation] = useState(null); // { lat, lng, address }
    const [startAddressInput, setStartAddressInput] = useState("");
    const [zipCodeFilter, setZipCodeFilter] = useState(''); // Comma separated string
    const [analyzeZipFilter, setAnalyzeZipFilter] = useState('all'); // Filter for Analyze mode
    const [soldDateFilter, setSoldDateFilter] = useState(null); // Default: show ALL properties
    const [highlightRecentlySold, setHighlightRecentlySold] = useState(false);
    const [showAllProperties, setShowAllProperties] = useState(false);
    const [viewMode, setViewMode] = useState('pins'); // 'pins' or 'heatmap'
    const [mode, setModeRaw] = useState('generate'); // Default to generate mode
    const setMode = (newMode) => {
        setModeRaw(newMode);
        // Logic moved to useEffect to be smarter about when to open
    };
    const [showDashboard, setShowDashboard] = useState(false);
    const [drawingMode, setDrawingMode] = useState(false);
    const [drawnPolygon, setDrawnPolygon] = useState(null);
    const [draftPolygon, setDraftPolygon] = useState([]);
    const [drawShape, setDrawShape] = useState('circle');
    const [drawSizeMiles, setDrawSizeMiles] = useState(40);
    // ... keep existing code (showTimingPanel through all remaining state declarations, useEffects, callbacks, and functions up to the return statement) ...

    // ... keep existing code (the entire return JSX) ...
}