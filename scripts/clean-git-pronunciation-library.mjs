import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pronunciationPath = path.join(root, 'src/lib/server/default_global_pronunciations.json');
const definitionPath = path.join(root, 'src/lib/server/default_global_definitions.json');
const tombstonePath = path.join(root, 'src/lib/server/default_global_pronunciation_tombstones.json');
const shouldApply = process.argv.includes('--apply');
const shouldCheck = process.argv.includes('--check');

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
};

const originalLibrary = readJson(pronunciationPath, {});
const originalDefinitions = readJson(definitionPath, {});
const originalTombstones = readJson(tombstonePath, { version: 1, generatedAt: null, entries: {} });

const choicePhonetic = (choice) => (
  typeof choice === 'string'
    ? choice
    : choice && typeof choice === 'object' && typeof choice.phonetic === 'string'
      ? choice.phonetic
      : null
);
const withPhonetic = (choice, phonetic) => (
  typeof choice === 'string' ? phonetic : { ...(choice || {}), phonetic }
);
const pronunciationChoices = (rawChoices) => (
  (Array.isArray(rawChoices) ? rawChoices : [rawChoices])
    .map(choicePhonetic)
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
);
const fingerprint = (value) => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

const scriptsIn = (value) => ({
  latin: /\p{Script=Latin}/u.test(value),
  greek: /\p{Script=Greek}/u.test(value),
  hebrew: /\p{Script=Hebrew}/u.test(value),
});
const letterCount = (value) => (
  [...value.normalize('NFC')].filter((character) => /[\p{L}\p{M}]/u.test(character)).length
);
const greekHasVowel = (value) => (
  /[αεηιουω]/u.test(value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase())
);
const canonicalWord = (value) => value
  .normalize('NFD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/[’'ʾʿ_-]/gu, '')
  .replace(/[^\p{L}]/gu, '');

const KNOWN_OCR_FRAGMENT_KEYS = new Set([
  'εκπ',
  'ντνατ',
  'νση',
  'αγγ',
  'αγγελ',
  'ξε',
  'ΝΕΙΤΟΣΝ',
  'επιτρσ',
  'δκληρρνδμσσ',
  'ντω',
  'πνεθμα',
  'πνε',
  'πνεν',
  'πνεύ',
  'πνενματκδν',
  'πνεν͂',
  'κληρρνδμρς',
  'νηπισ',
  'νηπισς',
  'ιτρσπσς',
  'ενδνν',
  'ρχη',
  'ξστιν',
  'κληρρνδμρι',
  'σικσν',
  'τνπικῶ',
  'νίὸς',
  'μμων',
  'ποκηρνκτος',
  'ηνπδητδς',
  'γνησισς',
  'Παλαιοπολίπας',
  'σνγγενε',
  'τεπηγγελλετο',
  'δδῆμο',
  'ιτρσπς',
  'πδλεω',
  'κληρσνδμσς',
  'πληρδω',
  'τδπληρωματδνχρδνδνσ',
  'ννη',
  'σσνμετ',
  'θνγατερας',
  'απνεν',
  'εδδξ',
  'σννεργ',
  'συνγκληρόνομον',
  'πρωτδτκκρ',
  'πρωτδτκκκκ',
  'φδβος',
  'νιισσιησητ',
  'ναιρονμ',
  'ξστω',
  'φντναπσιεῖσθαι',
  'κδσμον',
  'ένιαντούς',
  'δτεδε',
  'γινν',
  'πιστσς',
  'ννα',
  'ννμετ',
  'δονλειατη',
  'κας',
  'ἐνεργ',
  'Καλᾶτο',
  'οθε',
  'εἰσπο',
  'ιτροπο',
  'οικονομο',
  'ἀνσιν',
  'τιβερ',
  'τροσπο',
  'οἰκονομο',
  'έρμ',
  'ισθ',
  'οιητος',
  'οφῶν',
  'ενγεν',
  'μον',
  'απητδ',
  'αὐτδ',
  'αὐτφ͂',
  'αὐτδς',
  'ἀντ',
  'ἀνδρ',
  'νήπισ',
  'νήπ',
  'ἡμεῖ',
  'ίδωλα',
  'Αβρα',
  'εναγγ',
  'υἱοθεσ',
  'ἐλάβατε',
  'εῖσθαι',
  'π',
  'εγ',
  'ονν',
  'απ',
  'οῦ',
  'καἰ',
  'ανθε',
  'Α΄',
  'äß',
  'üß',
  'l_S',
  'neɪp',
  'dkliːrɒnmɒs',
  'ɑntoʊnk',
  'neɪris',
  'eɪs',
  'seɪsɪn',
  'spoʊ',
  'uːn',
  'eseɪ',
  'had',
  "d'",
  'lead',
  'separate',
  'live',
  'record',
  'close',
  'all',
]);

// Lexically cross-checked OCR slices from the historical shared release. These
// are source fragments or corrupted spellings, not reusable dictionary terms.
const RETIRED_GREEK_OCR_KEYS = new Set([
  'ΟΕ', 'Κεάε', 'νώς', 'τεκ', 'σπο', 'επ', 'πο', 'άλλ', 'στο', 'χε', 'δι', 'θε',
  'σθα', 'νηπ', 'τροπο', 'νσει', 'νίος', 'ελ', 'πολ', 'θετδ', 'ποιεῖσθ', 'υίδς', 'ητδ',
  'δρισθεις', 'πρωτδτ', 'σποιε', 'σποιεῖσθαι', 'θετ', 'θετδν', 'λο', 'ντῶ', 'εγωδ', 'θεσθα', 'σθαι',
  'νίός', 'εκνωσις', 'θετδνν', 'νίοῦ', 'προθεσμ', 'εκπο', 'καθ', 'θετδς', 'θρεπτδ', 'ηθῆνα', 'ἐπ', 'θεδ', 'δδελφο',
  'τηρ', 'πρωτδ', 'πατρδ', 'διδ', 'ναγγ', 'τρσπσι', 'ιτρσπσι', 'σμσι', 'πατρδς', 'τοδ', 'ημ', 'δτε', 'ριστδς',
  'δονλε', 'τηνν', 'σπερμ', 'δρισθ', 'δρισθείς', 'νίοθεσίας', 'γεγο', 'οπο', 'εκπσιεῖν', 'ἀπ', 'σποιεῖσθ',
  'σιν', 'γενεσθ', 'ιτιν', 'δεκ', 'μο', 'ποτ', 'υίδν', 'αλλ', 'νεργ', 'ετ', 'δεσπ', 'γενν', 'νσειπ', 'αφ', 'αθ', 'πατ',
  'νίοὺς', 'νίοθεσίαν', 'απολ', 'οὐδ', 'παιδ', 'δελφο', 'γεν', 'ἐφ', 'νγενη', 'λε', 'μετ', 'δο', 'επιτρδπσνς', 'κληρο',
  'νμῶν', 'εφ', 'αντωνκ', 'λος', 'κσνδμσι', 'κονόμοι', 'κονομο', 'επιτρ', 'διαφ', 'κδσμο', 'εξαπ', 'ποστελλειν',
  'ενοικ', 'εγεικ', 'θεδς', 'φορ', 'επαγγελ', 'δρίζειν', 'ριστο', 'εκσπ', 'βρα', 'δελφ', 'δεξ', 'ξχοντε', 'ντρωσι',
  'οπν', 'αβετε', 'σεν', 'βραάμ', 'νομ', 'οθετε', 'ΣΠΟΙΕΙΝ', 'ἀφ', 'ξαυτόν', 'ώστ', 'κληρονομ', 'δρου', 'πε', 'πον', 'έαυ',
  'στον', 'συνοι', 'κία', 'σπσιεῖσθαι', 'ἄνδρ', 'τοῦτ', 'πατρῷφ', 'οἴκφ', 'δνο', 'κον', 'ἐκληρο', 'νόμησε', 'σφάλματ',
  'ῖδ', 'δντα', 'εξδχ', 'ποιητ', 'πσιεισθαι', 'γονφ', 'λοιγ', 'εκτ', 'δπδθεν', 'ξωυτοῦ', 'ποιησειδε', 'ενο', 'υίωνους',
  'σωνι', 'πραγ', 'ματείαις', 'ταῦθ', 'υἰωνοί', 'Φοι', 'μἡ', 'δνυ', 'ισθαι', 'τεκν', 'ισποιε', 'ποιξισθαι', 'δπο', 'ἐνδι',
  'άρρ', 'βελ', 'ιεῖσθ', 'αρμεν', 'θεσειπα', 'νσιν', 'θεσθ', 'οτῶνφ', 'μηδ', 'θύγατρ', 'ὑοθετήσαντος', 'αλ', 'είσποι',
  'Σαραπ', 'μητρό', 'ΚΑΘ', 'ανδε', 'γενό', 'βάπ', 'γέγο', 'ἄλλφ', 'ὑπ', 'εκποιεῖσθ', 'νίοθετεῖσθαι', 'παιδδς', 'ονκα', 'αντ',
  'ωνθνγα', 'ιβερ', 'δθνείοις', 'ενθ', 'σεβδμενοι', 'θεδν', 'αδελφο', 'άναιροθντες', 'ξπαινον', 'πα',
]);

const ADDITIONAL_RETIRED_GREEK_OCR_KEYS = new Set([
  'νἱοθεσία', 'διαθήκτμ', 'σαντὸν', 'κονόμος', 'νίοθεσία', 'σποιεῖν', 'ὑοθεσίαν', 'εοσεβῶν',
  'τίστους', 'υἰοποιή', 'λεῖ', 'οθεσίαν', 'νσιος', 'βασιλ', 'νγεν', 'κλῆρρς', 'ητρς', 'ἀλλ', 'ἐπαρ', 'θηση',
  'επιγεγραμμ', 'επιγρ', 'ένδς', 'ιπ', 'τέρ', 'φομενο', 'νγενῆ', 'μδνο', 'ριστοι', 'μονν', 'ρετ', 'ζεν', 'τηρν', 'δικαιο',
  'σονται', 'μονδ', 'πητδ', 'βάβδος', 'εχθρ', 'πάγτων', 'ριοι', 'ριο', 'δεσπδτη', 'ηγεμ', 'ντων', 'μεγ', 'ικσν', 'ξπίτροπος',
  'ρμη', 'πίτροπος', 'δλη', 'γούς', 'σκοπο', 'δνδμο', 'νηπιδς', 'εγωδε', 'ταπει', 'δονλον', 'οπσνς', 'ρμσι', 'γραφ', 'εγει', 'λον',
  'κονόμους', 'ηπροθεσμ', 'ατο', 'δνρμο', 'ηπρδεσμ', 'υτ', 'νποι', 'νσῆνεβ', 'νθε', 'νσῆ', 'ξξαποστέλλειν', 'Αλθεν', 'Τουδαίοι',
  'νδμον', 'νδμο', 'νίότης', 'εχεσθ', 'ιτηνν', 'ελενθερ', 'δικ', 'δμο', 'εύλο', 'γία', 'ερμ', 'δικαισσνη', 'πιστδ', 'ναδ', 'πενδθεδ',
  'πων', 'ξσοντ', 'νοικήσω', 'εμπεριπατ', 'κήνωσις', 'ένμου', 'ἐμπεριπατήσωκαι', 'ἔσονταίκαι', 'ίμεις', 'λαδς',
  'σθητε', 'φορίσθητε', 'ελθατ', 'ισθητε', 'διδπερ', 'σδεξομ', 'ντο', 'κάγὼκα', 'ξσομαι', 'σδεξομα', 'νπελε', 'σδεξρμα', 'νμεῖ',
  'ρισθ', 'νίους', 'δμοιώματι', 'κομι', 'σαμένους', 'νμεθ', 'ενπ', 'σιντο', 'κνριρ', 'ησσθς', 'ελιονθεο', 'δπροεπηγγε', 'σασθαι',
  'ναγγελισν', 'δυνάμε', 'δρισθέντος', 'Δανίδ', 'τδπνεν', 'θανα', 'ννης', 'ὲνομ', 'ζετο', 'ζεσθ', 'δρισθε', 'δριζω', 'εξελ', 'πρόθε',
  'μετασχημα', 'απρδθεσιν', 'ντρωσις', 'αναστ', 'θερν', 'πατηρμον', 'εωντῆ', 'κος', 'εντσς', 'νματος', 'ατ', 'νματ', 'ξχοντες',
  'πεκδεχεσθ', 'απεκδ', 'τῶνν', 'δπεκδεχεσθ', 'σωματσς', 'τος', 'παρχ', 'ηπνε', 'νματσς', 'ντρα', 'οτ', 'γαπη', 'τός', 'οἰκ', 'νδτων',
  'ύδς', 'ποιητδ', 'ποιητδς', 'πην', 'τεταρτολο', 'γεῖτ', 'τιμ', 'ανειντ', 'υΙοποιεῖσθαι', 'οθ', 'νίοποιήσατο', 'τορ', 'ονποιεῖτ',
  'δαπο', 'σποιητο', 'έκλαμ', 'βάνοντες', 'ρῷ', 'μητρ', 'δηλο', 'σσος', 'νριρ', 'Παναθ', 'δπου', 'τρσπο', 'ηγεμδνε', 'σατρδπαι',
  'επιστ', 'ννεμο', 'ξθνη', 'νηπισι', 'αστοιχειατον', 'οσμ', 'νσειμ', 'πεπληρωταιδ', 'προστάγ', 'νισθεσια', 'εσν', 'ριστ', 'στεως',
  'θεσν', 'ελιοντον', 'ντον', 'γιωσδν', 'φιλο', 'ερ', 'ιοποιήτου', 'γο', 'υξοθεσίαν', 'ναιρεῖσθαι', 'ἀκρο', 'πλο', 'εκν', 'εστν', 'Μωϋ',
  'ξρημο', 'πολύτρωσις', 'οθεσία', 'λντρωτη', 'καιρ', 'ονδμον', 'ελρντες', 'ΥΙΟΘΕΣΙΛ', 'ετεραζ', 'οτος', 'δωλα', 'ρισσπαν', 'τοκράτωρ',
  'σραηλ', 'ενοικησωεν', 'ϵπιστολή', 'καρδ', 'Χριστο', 'σύνμετά', 'θνητ', 'σῶμ', 'κόνος', 'νἱγί', 'οναρλίαις', 'Πε', 'δημο', 'επεπο', 'ἀπολ', 'ι', 'ἀθ',
  'εὐγεν', 'ευγεν', 'ἐλ', 'ἐπιτρ', 'ἐξαπ', 'θανά', 'ενγ', 'ρισεν', 'απαρχ', 'ὥστ', 'εἰσπρ', 'Βελ',
  'ατης',
]);

const TRUSTED_PRONUNCIATION_REPAIRS = new Map(Object.entries({
  'υἱοθεσία': '/hwioʊθɛsiɑ/',
  'υἱοθεσίας': '/hwioʊθɛsiɑs/',
  'υιοθεσία': '/hwioʊθɛsiɑ/',
  'Υἱοθεσία': '/hwioʊθɛsiɑ/',
  'πνεύματος': '/njumɑtɒs/',
  'πνεῦμα': '/njumɑ/',
  'πνεύματι': '/njumɑti/',
  'πνεύμα': '/njumɑ/',
  'δεσπότης': '/dɛspɒteɪs/',
  'Σαραπίωνος': '/sɑrɑpioʊnoʊs/',
  'Διαφάνου': '/diɑfɑnu/',
  'ἀπάτορ': '/ɑpɑtɒr/',
  'ἀνάγει': '/ɑnɑɡeɪ/',
  'ἀνάγε': '/ɑnɑɡɛ/',
  'ἐξαίρετον': '/ɛksɑɪrɛtoʊn/',
  'γενει': '/ɡɛneɪ/',
  'ισθα': '/isθɑ/',
  'ἀγένεσιν': '/ɑɡɛnɛsin/',
  'πορεύσονται': '/poʊrjusɒntaɪ/',
  'ἐπιτροπούς': '/ɛpitroʊpus/',
  'ἐπιτρόποις': '/ɛpitroʊpɔɪs/',
  'οἰκονόμοις': '/ɔɪkoʊnoʊmɔɪs/',
  'λυτρωτή': '/lutroʊteɪ/',
  'ἔθνη': '/ɛθneɪ/',
  'λάβωμεν': '/lɑboʊmɛn/',
  'ἐμέ': '/ɛmɛ/',
  'ἐξηγόρασεν': '/ɛkseɪɡoʊrɑsɛn/',
  'ἐλευθερία': '/ɛljuθɛriɑ/',
  'καθὼς': '/kɑθoʊs/',
  'ματος': '/mɑtɒs/',
  'ἀνά': '/ɑnɑ/',
  'ασις': '/ɑsis/',
  'άντων': '/ɑntoʊn/',
  'θεσθαι': '/θɛsθaɪ/',
  'μιν': '/min/',
  'ιν': '/in/',
  'συγκληρονόμοι': '/suŋkleɪroʊnoʊmɔɪ/',
  'Ἰησοῦν': '/ieɪsuːn/',
  'τοῦ': '/tu/',
  'κληρονομία': '/kleɪroʊnoʊmiɑ/',
  'διό': '/dioʊ/',
  'μάρτυρε': '/mɑrturɛ/',
  'ὁρισθείς': '/hoʊrisθeɪs/',
  'σάρξ': '/sɑrks/',
  'ὁρισθέν': '/hoʊrisθɛn/',
  'ὁρίζω': '/hoʊrizoʊ/',
  'ὄντες': '/ɒntɛs/',
  'γεγονότων': '/ɡɛɡoʊnoʊtoʊn/',
  'αὐτῶ': '/aʊtoʊ/',
  'ποινῆς': '/pɔɪneɪs/',
  'ἐμα': '/ɛmɑ/',
  'περιεπτύσσετο': '/pɛriɛptusɛtoʊ/',
  'περιεποίησε': '/pɛriɛpɔɪeɪsɛ/',
  'ἐποιήσατο': '/ɛpɔɪeɪsɑtoʊ/',
  'ἐνδιατρίβειν': '/ɛndiɑtribeɪn/',
  'πάμπλουτος': '/pɑmplutoʊs/',
  'ψευδωνύμων': '/psjudoʊnumoʊn/',
  'εὐαγγέλιόν': '/juɑŋɡɛlioʊn/',
  'πορεύησθε': '/poʊrjueɪsθɛ/',
  'εὐαγγελίζεσθαι': '/juɑŋɡɛlizɛsθaɪ/',
  'ζῶντά': '/zoʊntɑ/',
  'κεφαλή': '/kɛfɑleɪ/',
  'διαφέρεις': '/diɑfɛreɪs/',
  'εὐκλεής': '/juklɛeɪs/',
  'εύθυβόλως': '/juθuboʊloʊs/',
  'κατασκηνόω': '/kɑtɑskeɪnoʊoʊ/',
  'ἀναιρεῖσθαι': '/ɑnaɪreɪsθaɪ/',
  'Άντιφωντος': '/ɑntifoʊntoʊs/',
  'οίκονόμος': '/ɔɪkoʊnoʊmoʊs/',
  'ἐπιστάται': '/ɛpistɑtaɪ/',
  'Φαραω': '/fɑrɑoʊ/',
  'ἀρχιστράτηγος': '/ɑrkistrɑteɪɡoʊs/',
  'ἐκατόναρχος': '/ɛkɑtoʊnɑrkoʊs/',
  'ἡγούμενος': '/heɪɡumɛnoʊs/',
  'ἡγεμών': '/heɪɡɛmoʊn/',
  'χιλίαρχος': '/kiliɑrkoʊs/',
  'εφεστῶτες': '/ɛfɛstoʊtɛs/',
  'Εβραίων': '/ɛbrɑɪoʊn/',
  'έπιστάτης': '/ɛpistɑteɪs/',
  'έφεστώς': '/ɛfɛstoʊs/',
  'τάσσω': '/tɑsoʊ/',
  'νομοι': '/noʊmɔɪ/',
  'ημεν': '/eɪmɛn/',
  'ἐπιστάτης': '/ɛpistɑteɪs/',
  'huiothesia': '/hwioʊθɛsiɑ/',
  'Huiothesia': '/hwioʊθɛsiɑ/',
  'huiothesian': '/hwioʊθɛsiɑn/',
  'huiothesias': '/hwioʊθɛsiɑs/',
  'huiothetein': '/hwioʊθɛteɪn/',
  'Huiothetein': '/hwioʊθɛteɪn/',
  'pneuma': '/njumɑ/',
  'pneumatos': '/njumɑtɒs/',
  'eispoiesasthai': '/eɪspɔɪeɪsɑsθaɪ/',
  'ekpoieisthai': '/ɛkpɔɪeɪsθaɪ/',
  'teknōsin': '/tɛknoʊsin/',
  'thesthai': '/θɛsθaɪ/',
  'thesin': '/θɛsin/',
  'thesei': '/θɛseɪ/',
  'eispoiētoi': '/eɪspɔɪeɪtɔɪ/',
  'aristoi': '/ɑristɔɪ/',
  'kyriou': '/kuriu/',
  'doulou': '/dulu/',
  'douloi': '/dulɔɪ/',
  'oikonomoi': '/ɔɪkoʊnoʊmɔɪ/',
  'epitropoi': '/ɛpitroʊpɔɪ/',
  'Christou': '/kristu/',
  'horisthentos': '/hoʊrisθɛntoʊs/',
  'tēn': '/teɪn/',
  'huioi': '/hwioɪ/',
  'kyrion': '/kurioʊn/',
  'Christon': '/kristoʊn/',
  'symmorphon': '/summoʊrfoʊn/',
  'klēronomoi': '/kleɪroʊnoʊmɔɪ/',
  'adelphois': '/ɑdɛlfɔɪs/',
  'pater': '/pɑtɛr/',
  'exaposteilen': '/ɛksɑpoʊsteɪlɛn/',
  'hēmeis': '/heɪmeɪs/',
  'חוט': '/xuːt/',
  'חור': '/hur/',
  'עדריאל': '/ɑdriɛl/',
  'יובלים': '/juvɑlim/',
  'חיצונים': '/xitsoʊnim/',
  'מצרים': '/mɪtsrɑjɪm/',
  'דילי': '/dili/',
  'חלש': '/xɑlɑʃ/',
  'חיש': '/xiːʃ/',
  'לא': '/loʊ/',
  'רשא': '/rɑʃɑ/',
  'ברא': '/bɑrɑ/',
  'לב': '/lɛv/',
  'ידי': '/jɑdeɪ/',
  'אמר': '/ɑmɑr/',
  'תוככם': '/toʊxəxɛm/',
  'עלו': '/ɑlu/',
  'על': '/ɑl/',
  'ינבל': '/jinbɑl/',
  'דא': '/dɑ/',
  'פרעה': '/pɑroʊ/',
  'רמא': '/rɑmɑ/',
  'אָמֵן': '/ɑmɛn/',
  'היה': '/hɑjɑ/',
  'דע': '/dɑ/',
  'תהא': '/tiheɪ/',
  'בל': '/bɑl/',
  'כול': '/koʊl/',
  'בני': '/bneɪ/',
}));

// Greek capitalization commonly changes at sentence boundaries without
// changing the lexical word. These reviewed groups must share one default.
// Do not generalize this to every case pair: capitalization can distinguish a
// proper name (for example Δία, Zeus) from a lowercase lexical form.
const REVIEWED_CASE_EQUIVALENT_DEFAULTS = new Map(Object.entries({
  'ποιεῖσθαι': '/pɔɪeɪsθaɪ/',
  'τίθεσθαι': '/tɪθɛsθaɪ/',
  'οὗτος': '/huːtɒs/',
  'θεοῦ': '/θɛu/',
  'κύριος': '/kurioʊs/',
  'είσποιεῖν': '/eɪspɔɪeɪn/',
  'γνήσιος': '/ɡneɪsioʊs/',
  'πάντας': '/pɑntɑs/',
  'μητρός': '/meɪtrɒs/',
  'υψιστος': '/hypsiːstɒs/',
  'θεος': '/θɛoʊs/',
  'έκποιεῖν': '/ɛkpɔɪeɪn/',
  'διαθήκαι': '/diɑθeɪkaɪ/',
  'διαθηκη': '/diɑθeɪkeɪ/',
}));

// Reviewed as potentially case-sensitive lexical distinctions; exact spelling
// remains authoritative and case-fold fallback intentionally stays disabled.
const REVIEWED_CASE_DISTINCT_GROUPS = new Set(['δία', 'δια']);

const RETIRED_HEBREW_OCR_KEYS = new Set([
  'סת', 'הוהי', 'תמודב', 'רס', 'ןמא', 'נימ', 'יכלב', 'תש', 'לע', 'יל', 'םע',
  'ואתח', 'משתב', 'אולא', 'שרי', 'לדה', 'אבר', 'ויתח', 'משאב', 'ירבד', 'רביאתמ',
  'אולד', 'ילידתל', 'שכלה', 'מגדלי', 'תוםב', 'חוךב', 'יתומ', 'עלהע', 'ליוה',
  'כתובכ', 'אילוי', 'לדו', 'ועדש', 'יבהא', 'תהת', 'כלכלניכ', 'יאא', 'ביל', 'אי',
  'דעניו', 'אמיע', 'ליכהע', 'זבחני', 'כיא', 'אמתכהו', 'ןוכ', 'דלי', 'םיהלאל',
  'עטנ', 'ספרה', 'הספריםה', 'מועדצ', 'אחךמ', 'שרימ', 'הנע', 'כאשרד', 'שעיהה',
  'נביאב', 'ןא', 'מוץל', 'והיהמ', 'שכניע', 'ליהםונתתימ', 'שכניב', 'תגלע',
  'ליהםכ', 'מרחמתע', 'ולה', 'וכאומןב', 'חיקת', 'כלכלל', 'כולמ', 'עשןיןכה',
  'םל', 'ארב', 'ול', 'היהת', 'ויהיל', 'הל', 'והואי', 'היהל', 'בעלו', 'עלל',
  'יתומיםו', 'רענ', 'תחותי', 'אשרוקר', 'אחורס', 'אערא', 'אפטרופו', 'ירקי',
  'םלוע',
]);

const keyProblems = (word) => {
  const trimmed = word.trim();
  const problems = [];
  if (!trimmed) problems.push('empty-key');
  if (trimmed.includes('/')) problems.push('ipa-or-slash-key');
  if (/\s/u.test(trimmed)) problems.push('multiword-key');
  if (/[\[\]{}()<>\d]/u.test(trimmed)) problems.push('markup-or-digit-key');
  if (/^[-–—]|[-–—]$/u.test(trimmed)) problems.push('truncated-key');
  if (/[_\\]/u.test(trimmed)) problems.push('markup-or-separator-key');
  if (/[ɐ-ʯː]/u.test(trimmed)) problems.push('ipa-as-key');
  const scripts = scriptsIn(trimmed);
  const scriptCount = Number(scripts.latin) + Number(scripts.greek) + Number(scripts.hebrew);
  if (scriptCount > 1) problems.push('mixed-script-key');
  if (!/[\p{Script=Latin}\p{Script=Greek}\p{Script=Hebrew}]/u.test(trimmed) || [...trimmed].some((character) => (
    /\p{L}/u.test(character)
    && !/[\p{Script=Latin}\p{Script=Greek}\p{Script=Hebrew}]/u.test(character)
    && !(/\p{Script=Latin}/u.test(trimmed) && /[ʾʿʼʽʻ]/u.test(character))
  ))) problems.push('unsupported-script-key');
  if (scripts.greek && /σ$/u.test(trimmed)) problems.push('nonfinal-greek-sigma-at-end');
  if (scripts.greek && /ς.+/u.test(trimmed)) problems.push('final-greek-sigma-inside-word');
  if (scripts.hebrew && /^[ךםןףץ]/u.test(trimmed)) problems.push('hebrew-final-letter-at-start');
  if (scripts.hebrew && /[כמנפצ]$/u.test(trimmed)) problems.push('hebrew-nonfinal-letter-at-end');
  if (
    scripts.greek
    && trimmed.normalize('NFC').toLowerCase() !== 'κτλ'
    && letterCount(trimmed) >= 2
    && !greekHasVowel(trimmed)
  ) {
    problems.push('greek-consonant-fragment');
  }
  if (scripts.greek && letterCount(trimmed) === 1 && !greekHasVowel(trimmed)) {
    problems.push('single-greek-consonant-fragment');
  }
  const letters = [...trimmed.normalize('NFD').replace(/\p{M}/gu, '')]
    .filter((character) => /\p{L}/u.test(character))
    .map((character) => character.toLowerCase());
  if (
    (scripts.greek || scripts.hebrew)
    && letters.length >= 2
    && new Set(letters).size === 1
  ) {
    problems.push('repeated-letter-key');
  }
  return [...new Set(problems)];
};

const pronunciationInner = (value) => String(value || '').trim().replace(/^\/|\/$/gu, '');
const pronunciationTokens = (value) => pronunciationInner(value)
  .split(/[\s,;_-]+/u)
  .filter(Boolean)
  .map((token) => token.toLowerCase());
const LETTER_NAMES = new Set([
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'eɪ', 'biː', 'siː', 'diː', 'iː', 'ɛf', 'dʒiː', 'eɪtʃ', 'aɪ',
  'dʒeɪ', 'keɪ', 'ɛl', 'ɛm', 'ɛn', 'oʊ', 'piː', 'kjuː', 'ɑːr',
  'ɛs', 'tiː', 'juː', 'viː', 'dʌbəljuː', 'ɛks', 'waɪ', 'ziː',
]);
const hasRepeatedToken = (value) => {
  const tokens = pronunciationTokens(value);
  return tokens.some((token, index) => index > 0 && token === tokens[index - 1]);
};
const looksLikeSpelledLetterGarbage = (word, value) => {
  if (word.normalize('NFC').toLowerCase() === 'κτλ') return false;
  if (!/[\p{Script=Greek}\p{Script=Hebrew}]/u.test(word)) return false;
  const tokens = pronunciationTokens(value);
  return tokens.length >= 3 && tokens.every((token) => LETTER_NAMES.has(token));
};
const looksLikePhonemeByPhonemeGarbage = (word, value) => {
  if (word.normalize('NFC').toLowerCase() === 'κτλ') return false;
  if (!/[\p{Script=Greek}\p{Script=Hebrew}]/u.test(word)) return false;
  const tokens = pronunciationTokens(value);
  return tokens.length >= 4 && tokens.every((token) => (
    [...token.replace(/[ːˑ]/gu, '')].length <= 2
  ));
};

const pronunciationProblems = (value) => {
  if (typeof value !== 'string') return ['not-text'];
  const trimmed = value.trim();
  if (!/^\/[^/]+\/$/u.test(trimmed)) return ['not-slash-delimited'];
  const inner = pronunciationInner(trimmed);
  const problems = [];
  if (inner === 'o') problems.push('standalone-o');
  if (inner.includes('ˈ')) problems.push('stress-marker');
  if (/[ħʕ]/u.test(inner)) problems.push('unsupported-pharyngeal');
  if (/[aeiouɑɒɔəɛɪʊ]\.[aeiouɑɒɔəɛɪʊ]/iu.test(inner)) problems.push('vowel-period-vowel');
  if (/[yj]{2,}/iu.test(inner)) problems.push('adjacent-yj');
  if (/\b(?:open|close|slash)\b/iu.test(inner)) problems.push('markup-word');
  if (/[\[\]()]|\s{2,}/u.test(inner)) problems.push('markup-spacing');
  if (/[A-Z]{2,}/u.test(inner)) problems.push('grouped-capitals');
  if (hasRepeatedToken(trimmed)) problems.push('repeated-token');
  return [...new Set(problems)];
};

const greekVowelNuclei = (word) => {
  const letters = [...word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()]
    .filter((character) => /\p{Script=Greek}/u.test(character));
  let count = 0;
  for (let index = 0; index < letters.length; index += 1) {
    if (
      index === 0
      && ['ι', 'υ'].includes(letters[index])
      && 'αεηιουω'.includes(letters[index + 1] || '')
    ) continue;
    if (!'αεηιουω'.includes(letters[index])) continue;
    const pair = `${letters[index]}${letters[index + 1] || ''}`;
    if (['αι', 'ει', 'οι', 'ου', 'αυ', 'ευ', 'ηυ', 'υι', 'ηι', 'ωι'].includes(pair)) index += 1;
    count += 1;
  }
  return count;
};

const ipaVowelNuclei = (value) => {
  const characters = [...pronunciationInner(value).toLowerCase()];
  const isVowel = (character) => /[aeiouyɑɒɔəɛɜɞɪʊæʌɨɐøœɯɤɵɚɝ]/u.test(character);
  const diphthongs = new Set(['aɪ', 'aʊ', 'eɪ', 'ɔɪ', 'oʊ', 'əʊ', 'ɛɪ', 'ɑɪ', 'ɑʊ']);
  let count = 0;
  for (let index = 0; index < characters.length; index += 1) {
    if (!isVowel(characters[index])) continue;
    if (diphthongs.has(`${characters[index]}${characters[index + 1] || ''}`)) index += 1;
    if (characters[index + 1] === 'ː') index += 1;
    count += 1;
  }
  return count;
};

const wordPronunciationProblems = (word, value) => {
  const problems = [];
  const normalizedWord = word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if ((normalizedWord.startsWith('πν') || normalizedWord.startsWith('pn')) && /^p/iu.test(pronunciationInner(value))) {
    problems.push('pronounces-silent-initial-p');
  }
  if (
    /\p{Script=Greek}/u.test(word)
    && greekVowelNuclei(word) - ipaVowelNuclei(value) >= 1
  ) {
    problems.push('incomplete-greek-word-pronunciation');
  }
  return problems;
};

const repairPronunciation = (value) => {
  if (typeof value !== 'string') return null;
  let inner = pronunciationInner(value);
  if (!inner) return null;
  if (inner === 'o') inner = 'oʊ';
  inner = inner
    .replace(/ˈ/gu, '')
    .replace(/[ħʕ]/gu, 'x')
    .replace(/([aeiouɑɒɔəɛɪʊ])\.([aeiouɑɒɔəɛɪʊ])/giu, '$1$2')
    .replace(/[yj]{2,}/giu, 'j')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  const repaired = `/${inner}/`;
  return pronunciationProblems(repaired).length === 0 ? repaired : null;
};

const trustedDefaultsByCanonical = new Map();
for (const [word, rawChoices] of Object.entries(originalLibrary)) {
  if (keyProblems(word).length > 0) continue;
  const choices = Array.isArray(rawChoices) ? rawChoices : [rawChoices];
  const value = choicePhonetic(choices[0]);
  if (
    !value
    || pronunciationProblems(value).length > 0
    || wordPronunciationProblems(word, value).length > 0
    || looksLikeSpelledLetterGarbage(word, value)
    || looksLikePhonemeByPhonemeGarbage(word, value)
  ) continue;
  const canonical = canonicalWord(word);
  if (!canonical) continue;
  const candidates = trustedDefaultsByCanonical.get(canonical) || [];
  candidates.push({ word, value: value.trim() });
  trustedDefaultsByCanonical.set(canonical, candidates);
}
const trustedCanonicalSibling = (word) => (
  (trustedDefaultsByCanonical.get(canonicalWord(word)) || [])
    .find((candidate) => candidate.word !== word)?.value || null
);

const cleanedLibrary = {};
const cleanedDefinitions = { ...originalDefinitions };
const tombstoneEntries = { ...(originalTombstones.entries || {}) };
const removed = [];
const repaired = [];
let removedChoices = 0;

const recordTombstone = (word, rawChoices, reasons) => {
  const previousChoices = pronunciationChoices(rawChoices);
  const entry = {
    reasons,
    pronunciations: {
      fingerprint: fingerprint(previousChoices),
      choices: previousChoices,
    },
  };
  if (Object.hasOwn(originalDefinitions, word)) {
    entry.definition = {
      fingerprint: fingerprint(originalDefinitions[word]),
      value: originalDefinitions[word],
    };
    delete cleanedDefinitions[word];
  }
  tombstoneEntries[word] = entry;
};

const definitionIsPlaceholder = (value) => {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return [
    /^fragment(?:ary)?\s+(?:or|\/)\s+(?:an?\s+)?inflected\s+form[.!]?$/iu,
    /^(?:an?\s+)?(?:ocr|word|text|unidentified)\s+fragment[.!]?$/iu,
    /^(?:an?\s+)?inflected\s+form(?:\s+or\s+(?:an?\s+)?(?:ocr\s+)?fragment(?:ary)?)?[.!]?$/iu,
    /\S+\s+fragment[.!]?$/iu,
  ].some((pattern) => pattern.test(normalized));
};

for (const [word, rawChoices] of Object.entries(originalLibrary)) {
  const choices = Array.isArray(rawChoices) ? rawChoices : [rawChoices];
  const problems = keyProblems(word);
  if (KNOWN_OCR_FRAGMENT_KEYS.has(word)) problems.push('known-ocr-fragment');
  if (RETIRED_GREEK_OCR_KEYS.has(word)) problems.push('known-damaged-or-fragmentary-greek');
  if (ADDITIONAL_RETIRED_GREEK_OCR_KEYS.has(word)) problems.push('known-damaged-or-fragmentary-greek');
  if (RETIRED_HEBREW_OCR_KEYS.has(word)) problems.push('known-reversed-or-damaged-hebrew');
  if (
    typeof originalDefinitions[word] === 'string'
    && /\S+\s+fragment[.!]?$/iu.test(originalDefinitions[word].trim())
  ) {
    problems.push('definition-identifies-fragment');
  }
  if (problems.length > 0) {
    const reasons = [...new Set(problems)];
    removed.push({ word, reasons });
    recordTombstone(word, rawChoices, reasons);
    continue;
  }

  const trustedRepair = TRUSTED_PRONUNCIATION_REPAIRS.get(word);
  if (trustedRepair) {
    const template = choices[0] || { usageCount: 0, isUserCustom: false };
    cleanedLibrary[word] = [withPhonetic(template, trustedRepair)];
    if (choicePhonetic(template) !== trustedRepair || choices.length !== 1) {
      repaired.push({ word, reason: 'manually-reviewed-full-word-pronunciation' });
    }
    removedChoices += Math.max(0, choices.length - 1);
    continue;
  }

  if (word.normalize('NFC').toLowerCase() === 'κτλ') {
    const template = choices[0] || { usageCount: 0, isUserCustom: false };
    cleanedLibrary[word] = [withPhonetic(template, '/K, T, L/')];
    if (choicePhonetic(template) !== '/K, T, L/' || choices.length !== 1) {
      repaired.push({ word, reason: 'known-initialism' });
    }
    removedChoices += Math.max(0, choices.length - 1);
    continue;
  }

  const defaultValue = choicePhonetic(choices[0]);
  if (
    defaultValue
    && (
      hasRepeatedToken(defaultValue)
      || looksLikeSpelledLetterGarbage(word, defaultValue)
      || looksLikePhonemeByPhonemeGarbage(word, defaultValue)
    )
  ) {
    const sibling = trustedCanonicalSibling(word);
    if (sibling) {
      cleanedLibrary[word] = [withPhonetic(choices[0], sibling)];
      repaired.push({ word, reason: 'trusted-orthographic-variant' });
      removedChoices += Math.max(0, choices.length - 1);
    } else {
      const reasons = ['stuttery-or-letter-spelling-default'];
      removed.push({ word, reasons });
      recordTombstone(word, rawChoices, reasons);
    }
    continue;
  }

  const kept = [];
  for (const choice of choices) {
    const value = choicePhonetic(choice);
    if (
      !value
      || hasRepeatedToken(value)
      || looksLikeSpelledLetterGarbage(word, value)
      || looksLikePhonemeByPhonemeGarbage(word, value)
    ) {
      removedChoices += 1;
      continue;
    }
    const normalized = pronunciationProblems(value).length > 0
      ? repairPronunciation(value)
      : value.trim();
    if (!normalized || wordPronunciationProblems(word, normalized).length > 0) {
      removedChoices += 1;
      continue;
    }
    if (kept.some((existing) => choicePhonetic(existing) === normalized)) {
      removedChoices += 1;
      continue;
    }
    kept.push(withPhonetic(choice, normalized));
  }

  if (kept.length === 0) {
    const sibling = trustedCanonicalSibling(word);
    if (sibling) {
      const template = choices[0] || { usageCount: 0, isUserCustom: false };
      cleanedLibrary[word] = [withPhonetic(template, sibling)];
      repaired.push({ word, reason: 'trusted-orthographic-variant' });
    } else {
      const reasons = ['no-safe-pronunciation-remained'];
      removed.push({ word, reasons });
      recordTombstone(word, rawChoices, reasons);
    }
    continue;
  }

  cleanedLibrary[word] = kept.slice(0, 5);
  if (JSON.stringify(choices) !== JSON.stringify(cleanedLibrary[word])) {
    repaired.push({ word, reason: 'removed-or-normalized-unsafe-choices' });
  }
}

const caseGroups = new Map();
for (const word of Object.keys(cleanedLibrary)) {
  if (!/\p{Script=Greek}/u.test(word)) continue;
  const folded = word.normalize('NFC').toLocaleLowerCase();
  const words = caseGroups.get(folded) || [];
  words.push(word);
  caseGroups.set(folded, words);
}

for (const [folded, words] of caseGroups) {
  if (words.length < 2) continue;
  const reviewedDefault = REVIEWED_CASE_EQUIVALENT_DEFAULTS.get(folded);
  if (!reviewedDefault) continue;

  const allChoices = words.flatMap((word) => cleanedLibrary[word] || []);
  const byPhonetic = new Map();
  for (const choice of allChoices) {
    const phonetic = choicePhonetic(choice);
    if (phonetic && !byPhonetic.has(phonetic)) byPhonetic.set(phonetic, choice);
  }
  const template = byPhonetic.get(reviewedDefault) || allChoices[0] || {};
  const synchronized = [
    withPhonetic(template, reviewedDefault),
    ...[...byPhonetic.entries()]
      .filter(([phonetic]) => phonetic !== reviewedDefault)
      .map(([, choice]) => choice),
  ].slice(0, 5);

  for (const word of words) {
    if (JSON.stringify(cleanedLibrary[word]) !== JSON.stringify(synchronized)) {
      repaired.push({ word, reason: 'reviewed-case-equivalent-pronunciations' });
    }
    cleanedLibrary[word] = synchronized.map((choice) => ({ ...choice }));
  }
}

const unreviewedCaseConflicts = [];
for (const [folded, words] of caseGroups) {
  if (words.length < 2 || REVIEWED_CASE_DISTINCT_GROUPS.has(folded)) continue;
  const defaults = new Set(words.map((word) => choicePhonetic(cleanedLibrary[word]?.[0])));
  if (defaults.size > 1) unreviewedCaseConflicts.push({ folded, words: [...words] });
}
if (unreviewedCaseConflicts.length > 0) {
  throw new Error(
    `Unreviewed case-equivalent pronunciation conflicts: ${JSON.stringify(unreviewedCaseConflicts)}`,
  );
}

for (const [word, definition] of Object.entries(originalDefinitions)) {
  if (!Object.hasOwn(cleanedDefinitions, word) || !definitionIsPlaceholder(definition)) continue;
  delete cleanedDefinitions[word];
  tombstoneEntries[word] = {
    ...(tombstoneEntries[word] || {}),
    reasons: [...new Set([...(tombstoneEntries[word]?.reasons || []), 'placeholder-definition'])],
    definition: {
      fingerprint: fingerprint(definition),
      value: definition,
    },
  };
}

const libraryChanged = JSON.stringify(cleanedLibrary) !== JSON.stringify(originalLibrary);
const definitionsChanged = JSON.stringify(cleanedDefinitions) !== JSON.stringify(originalDefinitions);
const tombstonesChanged = removed.length > 0 || definitionsChanged;
const hasChanges = libraryChanged || definitionsChanged || tombstonesChanged;
const nextTombstones = tombstonesChanged
  ? { version: 1, generatedAt: new Date().toISOString(), entries: tombstoneEntries }
  : originalTombstones;

if (shouldApply && hasChanges) {
  fs.writeFileSync(pronunciationPath, `${JSON.stringify(cleanedLibrary)}\n`);
  fs.writeFileSync(definitionPath, `${JSON.stringify(cleanedDefinitions)}\n`);
  fs.writeFileSync(tombstonePath, `${JSON.stringify(nextTombstones, null, 2)}\n`);
}

const report = {
  mode: shouldApply ? 'apply' : shouldCheck ? 'check' : 'dry-run',
  changed: hasChanges,
  before: {
    words: Object.keys(originalLibrary).length,
    choices: Object.values(originalLibrary).reduce(
      (total, choices) => total + (Array.isArray(choices) ? choices.length : 1),
      0,
    ),
    definitions: Object.keys(originalDefinitions).length,
  },
  after: {
    words: Object.keys(cleanedLibrary).length,
    choices: Object.values(cleanedLibrary).reduce(
      (total, choices) => total + (Array.isArray(choices) ? choices.length : 1),
      0,
    ),
    definitions: Object.keys(cleanedDefinitions).length,
  },
  removedWords: removed.length,
  repairedWords: repaired.length,
  removedChoices,
  removedDefinitions: Object.keys(originalDefinitions).length - Object.keys(cleanedDefinitions).length,
  removed,
  repaired,
};
console.log(JSON.stringify(report, null, 2));
if (shouldCheck && hasChanges) process.exitCode = 1;
