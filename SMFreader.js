var midiFile = {};

function error(str) {
	alert("Error: " + str);
}

function appendText( e, text ) {
	e.appendChild( document.createTextNode( text ) );
}

function dumpFileInfo( e ) {	// Performs a simple dump of the MIDI file
	var i, j;

	if (!e)
		return;
	
	e.innerHTML = "File type: " + midiFile.format + "<br>" + 
		"Number of tracks: " + midiFile.numTracks + "<br>" + 
		"Ticks per beat: " + midiFile.ticksPerBeat + "<br>";
		
	for (i = 0; i<midiFile.numTracks; i++) {
		var track = midiFile.tracks[i];
		appendText( e, "Track #" + i + ": ")
		if (track.trackName)
			appendText( e, "\"" + track.trackName + "\" ");
		appendText( e, track.events.length + " events" );
		e.appendChild( document.createElement( "br" ) );

		var str="";
		
		for (j=0;j<track.events.length;j++) {
			var ev = track.events[j];

			str += "(" + ev.delta + ")";
			
			if (ev.type == "MIDI") {
				var n = (ev.midiEventType << 4) + ev.midiChannel;
				str += "[" + n.toString(16) + " " + ev.parameter1.toString(16);
				if (ev.hasOwnProperty( "parameter2" ) )
					str += " " + ev.parameter2.toString(16);
				str += "] ";
			} else if (ev.type == "meta") {
				str += "[meta " + ev.metaType.toString(16) + " " + ev.metaData.length + "bytes]";
			} else {	// must be sysex
				str += "[sysex: " + ev.metaData.length + "bytes]";
			}
			
		}
		appendText(e, str);
		e.appendChild( document.createElement( "br" ) );
		e.appendChild( document.createElement( "br" ) );
	}

}

function decodeVariableLengthValue(data, trackOffset ) {
	var i;
	var idx = trackOffset;
	var result = 0;
	
	do   {
		i = data.getUint8(idx++);
		result = result << 7;		// left-shift by 7 bits
		result += (i & 0x7f);	// mask off the top bit
	} while (i>0x80);
	
	return {idx:idx,result:result};
}

function decodeMetaEvent( data, trackOffset, track, trackEvent ) {
	var idx = trackOffset + 1;  // we already know the first byte is 0xff
	var result;
	var length;
	var end;
	var metaData = [];
	
	trackEvent.type = "meta";
	
	trackEvent.metaType = data.getUint8(idx++);
/*	Type	Event	Type	Event
	0x00	 Sequence number	 
	0x01	 Text event	 
	0x02	 Copyright notice	 
	0x03	 Sequence or track name	 
	0x04	 Instrument name	 
	0x05	 Lyric text	 
	0x06	 Marker text	 
	0x07	 Cue point
	0x20	 MIDI channel prefix assignment
	0x2F	 End of track
	0x51	 Tempo setting
	0x54	 SMPTE offset
	0x58	 Time signature
	0x59	 Key signature
	0x7F	 Sequencer specific event */

	result = decodeVariableLengthValue( data, idx );
	idx = result.idx;
	length = result.result;
	end = idx + length;

	while (idx < end) {
		metaData.push(data.getUint8(idx++));
	}
	
	trackEvent.metaData = metaData;
	
	if (trackEvent.metaType == 0x03) {
		var str = "";
		var i;
		for (i=0; i<metaData.length; i++)
		   str += String.fromCharCode( metaData[i]);
		track.trackName = str;
	}

	return idx;
}

function decodeSysexEvent( data, trackOffset, track, trackEvent ) {
	var idx = trackOffset;
	var metaData = [];
	var d;

	trackEvent.type = "sysex";
	metaData.push(data.getUint8(idx++));

	do {
		d = data.getUint8(idx++);
		metaData.push(d);
	} while (d!=0xf7);

	trackEvent.metaData = metaData;
	return idx;
}

function decodeMIDIEvent( data, idx, trackEvent ) {
	var eventType = data.getUint8(idx++);
	
	trackEvent.type = "MIDI";

	trackEvent.midiEventType = (eventType & 0xf0)>>4;
	trackEvent.midiChannel = eventType & 0x0f;
	
	trackEvent.parameter1 = data.getUint8(idx++);
	
	// program change and channel aftertouch don't have a param2
	if ((trackEvent.midiEventType != 0x0c)&&(trackEvent.midiEventType != 0x0d))
		trackEvent.parameter2 = data.getUint8(idx++);

	return (idx);
}

function decodeRunningModeMIDIEvent( data, idx, trackEvent, lastEvent ) {
	trackEvent.type = "MIDI";
	trackEvent.midiEventType = lastEvent.midiEventType;
	trackEvent.midiChannel = lastEvent.midiChannel;
	
	trackEvent.parameter1 = data.getUint8(idx++);
	
	// program change and channel aftertouch don't have a param2
	if ((trackEvent.midiEventType != 0x0c)&&(trackEvent.midiEventType != 0x0d))
		trackEvent.parameter2 = data.getUint8(idx++);

	return (idx);
}

function decodeTrackEvent( data, track, trackOffset ) {
	var eventLength; // in bytes
	var time;		// time this event occurs (delta)
	var trackEvent = {};
	var result;
	var idx = trackOffset;
	var lastEventIdx = track.events.length;

	result = decodeVariableLengthValue( data, idx );
	idx = result.idx;
	trackEvent.delta = result.result;

	// figure out what type of event we have - DON'T increment the index!!
	var i = data.getUint8(idx);
	if (i==0xff)
	  idx = decodeMetaEvent( data, idx, track, trackEvent );
	else if ((i==0xf0)||(i==0xf7))
	  idx = decodeSysexEvent( data, idx, track, trackEvent );
	else if (i & 0x80) // non-running-mode MIDI Event
	  idx = decodeMIDIEvent( data, idx, trackEvent );
	else if (lastEventIdx > 0)
	  idx = decodeRunningModeMIDIEvent( data, idx, trackEvent, track.events[track.events.length-1] );
	else {error("Running mode event with no previous event!"); return -1;}

	track.events.push(trackEvent);

	return idx;
}

function decodeTrack( data, track, trackOffset ) {
	var idx = trackOffset;
	var length;
	var end;
	
	//   char           ID[4];  // Track header "MTrk" 
	if ( (data.getUint8(idx++) != 0x4d) ||
	 	 (data.getUint8(idx++) != 0x54) ||
	 	 (data.getUint8(idx++) != 0x72) ||
	 	 (data.getUint8(idx++) != 0x6b) )
	  {error("malformed track header"); return -1;}
			
	//   unsigned long length;  // length of track chunk in bytes
	track.byteLength = data.getUint32(idx);
	idx+=4;
	end = idx + track.byteLength;

	track.events = [];	// creates an empty array
	
	// any number of trackEvents.
	while (idx < end) {
		idx = decodeTrackEvent( data, track, idx );
		if (idx == -1)
			{error("error decoding track event"); return -1;}
	}
	
//	{error("error"); return -1;}
	return idx;
}

function decodeSMF( buffer ) {
	var data = new DataView(buffer);
	var idx=0;
	midiFile = {}; // clear the midi file object if it's already allocated
	
//	document.getElementById("updates").innerHTML = "";
//  alert( "File is " + buffer.byteLength + " bytes long.");

//   char           ID[4];  // File header "MThd" 
	if ( (data.getUint8(idx++) != 0x4d) ||
	 	 (data.getUint8(idx++) != 0x54) ||
	 	 (data.getUint8(idx++) != 0x68) ||
	 	 (data.getUint8(idx++) != 0x64) )
	  return(error("malformed file header"));
		
//   unsigned long  Length; /* This should be 6 */
	if (data.getUint32(idx) != 6)
	  return(error("file header length is not 6."));
	idx+=4;

//   unsigned short format;
	midiFile.format = data.getUint16(idx);
	idx+=2;
	
	if ((midiFile.format < 0) || (midiFile.format > 2) )
		return(error("MIDI file format " + midiFile.format + " unrecognized."));
	
		if (midiFile.format == 2 )
			return(error("MIDI file format type 2 not supported."));

//   unsigned short numTracks;
	midiFile.numTracks = data.getUint16(idx);
	idx+=2;

//   unsigned short ticksPerBeat;
	midiFile.ticksPerBeat = data.getUint16(idx);
	idx+=2;

	midiFile.tracks=new Array(midiFile.numTracks);
	for (iTrack=0; iTrack<midiFile.numTracks; iTrack++) {
		midiFile.tracks[iTrack] = {};
		idx = decodeTrack( data, midiFile.tracks[iTrack], idx);
		if (idx == -1)
	  		return(error("error reading track #" + iTrack));
	}
	
//	alert("Success!");
	dumpFileInfo( document.getElementById("updates") );
}
