// Only registered public addressing authorities may supply local road proof.
// Each adapter retains its own source identity, field meanings and restrictions;
// adding a region does not widen the road provider's matching distance.
export const COUNTY_ROAD_SERVICE = 'https://services.gis.nc.gov/secure/rest/services/NC1Map_Transportation/FeatureServer/0/query';
export const COUNTY_ADDRESS_SERVICE = 'https://services.gis.nc.gov/secure/rest/services/AddressNC/NC1Map_Addresses/FeatureServer/0/query';
export const LEE_ROAD_SERVICE = 'https://services2.arcgis.com/LvWGAAhHwbCJ2GMP/arcgis/rest/services/Road_Centerlines_with_Address_Ranges/FeatureServer/0/query';
export const LEE_ADDRESS_SERVICE = 'https://services2.arcgis.com/LvWGAAhHwbCJ2GMP/arcgis/rest/services/NG911_Address_Points/FeatureServer/0/query';

const roadFields = ['objectid', 'nguid', 'st_predir', 'st_name', 'st_postyp', 'st_posdir',
    'county_l', 'county_r', 'fromaddr_l', 'toaddr_l', 'fromaddr_r', 'toaddr_r',
    'parity_l', 'parity_r', 'postcode_l', 'postcode_r', 'oneway', 'roadclass',
    'dateupdate', 'effective', 'expire', 'gc_exception'];
const addressFields = ['objectid', 'st_address', 'full_address', 'add_number', 'addnum_suf',
    'unit', 'post_code', 'state', 'county', 'source', 'placement', 'dateupdate', 'effective', 'expire'];
const leeRoadFields = ['OBJECTID', 'NGUID', 'St_PreDir', 'St_Name', 'St_PosTyp', 'St_PosDir',
    'St_PreMod', 'St_PreTyp', 'St_PreSep', 'St_PosMod', 'Country_L', 'Country_R', 'State_L', 'State_R',
    'County_L', 'County_R', 'FromAddr_L', 'ToAddr_L', 'FromAddr_R', 'ToAddr_R', 'AdNumPre_L', 'AdNumPre_R',
    'Parity_L', 'Parity_R', 'PostCode_L', 'PostCode_R', 'OneWay', 'RoadClass', 'DateUpdate', 'Effective', 'Expire',
    'MSLINK_RCL', 'turn_mask', 'F_ELEV', 'T_ELEV', 'ErrorCode'];
const leeAddressFields = ['OBJECTID', 'Full_Address', 'LFull_St_Name', 'Add_Number', 'AddNum_Pre', 'AddNum_Suf',
    'Unit', 'Post_Code', 'Country', 'State', 'County', 'Placement', 'DateUpdate', 'Effective', 'Expire', 'MSLINK_RCL'];
const lower = attributes => Object.fromEntries(Object.entries(attributes || {}).map(([name, value]) => [name.toLowerCase(), value]));
const none = value => value == null || value === '' || value === 0 || value === '0';
const validRecord = a => Number.isInteger(a?.objectid) && a.objectid > 0
    && ['dateupdate', 'effective', 'expire'].every(name => a[name] == null || Number.isFinite(a[name]));
const leeRoad = attributes => {
    const a = lower(attributes);
    return { ...a, authority_record: { ...attributes } };
};

const nc = Object.freeze({ id: 'nc911', state: 'NC', source: 'nc_ng911_centerlines', addressSource: 'nc_address_point',
    addressId: 'nc_address', roadService: COUNTY_ROAD_SERVICE, addressService: COUNTY_ADDRESS_SERVICE,
    roadFields, addressFields, contains: p => p.lat >= 33.7 && p.lat <= 36.7 && p.lng >= -84.4 && p.lng <= -75.3,
    addressWhere: (house, zip) => `add_number='${house}' AND post_code='${zip}'`,
    normalizeRoad: a => a, normalizeAddress: a => a, validRoad: () => true, validAddress: () => true,
    targetMatchesAddress: () => true, requiresAddress: false });

const lee = Object.freeze({ id: 'fl_lee911', state: 'FL', source: 'fl_lee_ng911_centerlines', addressSource: 'fl_lee_address_point',
    addressId: 'fl_lee_address', roadService: LEE_ROAD_SERVICE, addressService: LEE_ADDRESS_SERVICE,
    roadFields: leeRoadFields, addressFields: leeAddressFields,
    // This bounds the lookup, while returned county/state and exact identity
    // decide coverage. Neighboring counties are never inferred from this box.
    contains: p => p.lat >= 26.3 && p.lat <= 26.83 && p.lng >= -82.5 && p.lng <= -81.55,
    addressWhere: (house, zip) => `Add_Number=${house} AND Post_Code='${zip}'`,
    normalizeRoad: leeRoad,
    normalizeAddress: attributes => {
        const a = lower(attributes);
        return { ...a, st_address: `${a.add_number} ${a.lfull_st_name || ''}`, authority_record: { ...attributes } };
    },
    validRoad: a => validRecord(a) && a.state_l === 'FL' && a.state_r === 'FL'
        && a.county_l === 'LEE COUNTY' && a.county_r === 'LEE COUNTY'
        && a.country_l === 'US' && a.country_r === 'US'
        && ['S', 'H'].includes(a.roadclass) && none(a.turn_mask) && none(a.errorcode)
        && a.f_elev === 0 && a.t_elev === 0
        && !a.st_premod && !a.st_pretyp && !a.st_presep && !a.st_posmod && !a.adnumpre_l && !a.adnumpre_r
        && Number.isInteger(a.mslink_rcl) && a.mslink_rcl > 0,
    validAddress: a => validRecord(a) && a.state === 'FL' && a.county === 'LEE COUNTY' && a.country === 'US'
        && !a.addnum_pre && Number.isInteger(a.mslink_rcl) && a.mslink_rcl > 0,
    targetMatchesAddress: (road, address) => road.mslink_rcl === address?.mslink_rcl,
    requiresAddress: true });

const authorities = [nc, lee];
export function countyAuthorityFor(stop) {
    return authorities.find(authority => (!stop?.state || String(stop.state).toUpperCase() === authority.state)
        && authority.contains(stop)) || null;
}

// Cached normalized evidence must still be an exact translation of the source
// attributes, not a modified road direction/range with an unchanged source ID.
export function validAuthorityAttributes(authority, attributes, kind) {
    if (!attributes || !authority) return false;
    if (authority === nc) return true;
    if (!attributes.authority_record || typeof attributes.authority_record !== 'object'
        || Array.isArray(attributes.authority_record)) return false;
    const normalized = kind === 'road' ? authority.normalizeRoad(attributes.authority_record)
        : authority.normalizeAddress(attributes.authority_record);
    const equal = (left, right) => {
        if (left === right) return true;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
            || Array.isArray(left) || Array.isArray(right)) return false;
        const names = Object.keys(left);
        return names.length === Object.keys(right).length
            && names.every(name => Object.hasOwn(right, name) && equal(left[name], right[name]));
    };
    return equal(normalized, attributes);
}
