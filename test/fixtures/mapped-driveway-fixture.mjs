// Real public geometry read October 15, 2026. OpenStreetMap contributors:
// https://www.openstreetmap.org/way/836726430 (v1), /way/16634481 (v7),
// /node/4059174054. Independent AddressNC identity: objectid 2022042.
// The 151-acre parcel's saved centroid is deliberately preserved.
export function createMappedDrivewayFixture() {
    const stop = { address_hash: '154 EMMA LN|28625', house_number: '154', street_name: 'Emma Ln',
        city: 'Statesville', state: 'NC', zip_code: '28625', lat: 35.84865, lng: -80.98886 };
    const referenceAddress = { source: 'nc_address_point', id: 'nc_address:2022042',
        point: { lat: 35.84254273194383, lng: -80.99085215360058 },
        attributes: { objectid: 2022042, state: 'NC', add_number: '154', st_address: '154 EMMA LANE', post_code: '28625' } };
    const driveway = [
        [171822265,35.8402171,-80.9930308],[7809317388,35.8404301,-80.9928477],
        [7809317389,35.8406746,-80.9926239],[7809317390,35.8408168,-80.9924733],
        [7809317391,35.8409647,-80.9922762],[7809317392,35.8410854,-80.9921166],
        [7809317393,35.8413732,-80.9917956],[7809317394,35.8415657,-80.9915786],
        [7809317395,35.8416035,-80.9915173],[7809317396,35.8416532,-80.9913918],
        [7809317397,35.84168,-80.9912673],[7809317398,35.8417408,-80.9912021],
        [7809317399,35.8418906,-80.9911282],[7809317400,35.8420661,-80.9911029],
        [7809317401,35.8423314,-80.9911177],[7809317402,35.8423613,-80.9910808],
        [7809317403,35.8423769,-80.9909968],[7809317404,35.8423757,-80.9909304],
        [7809317405,35.842341,-80.9908463],[7809317406,35.8422944,-80.9907977],
        [7809317407,35.8422382,-80.9907977],[7809317408,35.8421808,-80.9908301],
        [7809317409,35.8421414,-80.9908921],[7809317410,35.8421007,-80.9910012],
        [7809317400,35.8420661,-80.9911029],
    ];
    const road = [[171632339,35.8366926,-80.992985],[7036153466,35.8381095,-80.9930072],
        [171822260,35.8384824,-80.993004],[7933876194,35.8385754,-80.9930061],
        [8484671677,35.8390597,-80.9930137],[7730356032,35.8393095,-80.993018],
        [7730356035,35.8396307,-80.9930309],[171822265,35.8402171,-80.9930308]];
    const nodes = new Map([...driveway, ...road].map(([id,lat,lon]) => [id,{type:'node',id,lat,lon,version:1}]));
    nodes.set(4059174054,{type:'node',id:4059174054,version:1,lat:35.8425383,lon:-80.9908094,
        tags:{'addr:housenumber':'154','addr:street':'Emma Lane','addr:postcode':'28625','addr:state':'NC','addr:country':'US'}});
    const mapData = { elements: [...nodes.values(),
        { type:'way',id:836726430,version:1,nodes:driveway.map(n=>n[0]),tags:{highway:'service',service:'driveway',access:'private'} },
        { type:'way',id:16634481,version:7,nodes:road.map(n=>n[0]),tags:{highway:'residential',name:'Emma Lane'} } ] };
    const providerCalls = [], mapCalls = [];
    const response = data => ({ok:true,status:200,json:async()=>structuredClone(data)});
    const fetchImpl = async url => { mapCalls.push(String(url));return response(mapData); };
    const vehicleFetch = async url => {
        providerCalls.push(String(url));
        const frontage=[-80.9930308,35.8402171],south=[-80.9930309,35.8396307];
        if (String(url).includes('/nearest/')) return response({code:'Ok',waypoints:[{name:'Emma Lane',location:frontage,distance:0,nodes:[7730356035,171822265]}]});
        return response({code:'Ok',waypoints:[south,frontage,south].map(location=>({location,name:'Emma Lane',distance:0})),
            routes:[{legs:[{distance:65,duration:9.4},{distance:65,duration:9.4}],geometry:{type:'LineString',coordinates:[south,frontage,south]}}]});
    };
    return {stop,referenceAddress,mapData,fetchImpl,vehicleBaseUrl:'https://roads.test',vehicleFetch,providerCalls,mapCalls};
}
